package projection

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Error Signature: a normalized identity under which recurring error
// observations are recognised as the same error. The identity is defined once
// here, in the projection, so no view has to decide for itself whether two
// errors are "the same" or whether an error belongs to a file.
//
// Signatures are host-local derived state, rebuilt from the spool like the rest
// of the Projection. They are never spooled, so their keys stay readable.

const (
	errorSummaryMaxRunes = 160
	errorDigestTokenLen  = 16
	errorSignaturePaths  = 20
	// errorSignatureSessionMembers caps how many qualifying event ids one
	// signature remembers per session. The earliest (Time, ID) members are
	// kept, so the list is order-independent; len(members) == cap is the
	// truncation signal for consumers.
	errorSignatureSessionMembers = 500
)

var (
	hexRunPattern   = regexp.MustCompile(`[0-9a-f]{6,}`)
	digitRunPattern = regexp.MustCompile(`[0-9]+`)
)

// ErrorSignature summarises every error observation that shares one key.
// Counts are global to the Projection; see Projection.ErrorSignatures.
type ErrorSignature struct {
	Key       string    `json:"key"` // source|category|name|class
	Source    string    `json:"source"`
	Category  string    `json:"category"`
	Name      string    `json:"name,omitempty"`
	Class     string    `json:"class,omitempty"`
	Sample    string    `json:"sample,omitempty"` // raw summary of the earliest (Time, ID) observation carrying one
	Count     int       `json:"count"`
	Sessions  int       `json:"sessions"` // distinct non-empty session_ids
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Paths     []string  `json:"paths,omitempty"` // sorted, capped at 20
	// Members is session-scoped: set only when a session filter is applied,
	// holding that session's qualifying event ids in (Time, ID) order, capped
	// at 500 earliest (len == 500 means truncated). Omitted otherwise.
	Members []string `json:"members,omitempty"`
}

// memberObs orders one member observation; Time first so Members reads
// chronologically, ID as the deterministic tiebreak.
type memberObs struct {
	time time.Time
	id   string
}

type errorSignatureEntry struct {
	ErrorSignature
	// members holds per-session qualifying event observations, each slice
	// sorted by (Time, ID) and capped at errorSignatureSessionMembers keeping
	// the earliest, so the result does not depend on application order. The
	// map keys double as the distinct-session set (Sessions).
	members  map[string][]memberObs
	sessions map[string]ErrorSession
	// sampleTime/sampleID identify the observation Sample came from. Sample is
	// pinned to the earliest (Time, ID) observation with a non-empty summary,
	// not the first applied, so a rebuild that reads the spool in a different
	// order than events arrived live still reports the same Sample.
	sampleTime time.Time
	sampleID   string
}

// isErrorObservation reports whether ev is an error observation. It is the one
// qualification predicate shared by the attention overlay (HasError) and Error
// Signatures, so the two surfaces cannot drift.
func isErrorObservation(ev event.Event) bool {
	return ev.Category == event.CategoryError || ev.Severity == event.SeverityError
}

// normalizeErrorSummary reduces a summary to the form used as a signature class
// when the event carries no structured error_class. It is deliberately
// conservative: lowercase, whitespace collapsed, hex runs of 6+ characters
// (ids, digests, addresses) and then remaining digit runs replaced by '#', and
// truncated to 160 runes. Hex runs go first so an id mixing digits and letters
// collapses to a single '#' instead of fragmenting into per-digit placeholders.
// Paths are not stripped, so the same command against two files stays two
// signatures.
func normalizeErrorSummary(s string) string {
	s = strings.Join(strings.Fields(strings.ToLower(s)), " ")
	s = hexRunPattern.ReplaceAllString(s, "#")
	s = digitRunPattern.ReplaceAllString(s, "#")
	if r := []rune(s); len(r) > errorSummaryMaxRunes {
		s = string(r[:errorSummaryMaxRunes])
	}
	return s
}

// errorClass picks the most structured discriminator available: a non-empty
// payload.error_class string, else the first 16 characters of a privacy digest
// standing in for it (minimal mode), else the normalized summary.
func errorClass(ev event.Event) string {
	switch v := ev.Payload["error_class"].(type) {
	case string:
		if v != "" {
			return v
		}
	case map[string]any:
		if sum, ok := v["sha256"].(string); ok && sum != "" {
			return digestToken(sum)
		}
	case map[string]string:
		if sum := v["sha256"]; sum != "" {
			return digestToken(sum)
		}
	}
	return normalizeErrorSummary(ev.Summary)
}

func digestToken(sum string) string {
	if len(sum) > errorDigestTokenLen {
		return sum[:errorDigestTokenLen]
	}
	return sum
}

// errorSignatureKey is the readable source|category|name|class transport form
// of a signature's identity tuple.
func errorSignatureKey(ev event.Event, class string) string {
	return ev.Source + "|" + string(ev.Category) + "|" + ev.Name + "|" + class
}

// ErrorObservationKey exposes the canonical qualification and identity for
// scoped derived views. It does not mutate the projection or capture history.
func ErrorObservationKey(ev event.Event) (string, bool) {
	if !isErrorObservation(ev) {
		return "", false
	}
	return errorSignatureKey(ev, errorClass(ev)), true
}

// foldErrorSignature adds one error observation. The caller holds ix.mu and
// has already passed the exact-ID dedupe.
func (ix *Projection) foldErrorSignature(ev event.Event) {
	if !isErrorObservation(ev) {
		return
	}
	class := errorClass(ev)
	key := errorSignatureKey(ev, class)
	e, ok := ix.errSigs[key]
	if !ok {
		e = &errorSignatureEntry{
			ErrorSignature: ErrorSignature{
				Key:       key,
				Source:    ev.Source,
				Category:  string(ev.Category),
				Name:      ev.Name,
				Class:     class,
				FirstTime: ev.Time,
				LastTime:  ev.Time,
			},
			members:  map[string][]memberObs{},
			sessions: map[string]ErrorSession{},
		}
		ix.errSigs[key] = e
	}
	e.Count++
	if ev.Summary != "" &&
		(e.Sample == "" || ev.Time.Before(e.sampleTime) ||
			(ev.Time.Equal(e.sampleTime) && ev.ID < e.sampleID)) {
		e.Sample = ev.Summary
		e.sampleTime = ev.Time
		e.sampleID = ev.ID
	}
	if ev.Time.Before(e.FirstTime) {
		e.FirstTime = ev.Time
	}
	if !ev.Time.Before(e.LastTime) {
		e.LastTime = ev.Time
	}
	// Membership follows the same order-independence rule as Paths: each
	// session's slice stays sorted by (Time, ID) and a cap keeps the earliest
	// members. The caller has already passed the exact-ID dedupe, so an id can
	// only fold once; the equality skip below is defensive.
	if ev.SessionID != "" {
		row, exists := e.sessions[ev.SessionID]
		if !exists {
			row = ErrorSession{SessionID: ev.SessionID, Source: ev.Source, FirstTime: ev.Time, LastTime: ev.Time, SampleEventID: ev.ID}
		}
		row.Count++
		if ev.Time.Before(row.FirstTime) || (ev.Time.Equal(row.FirstTime) && ev.ID < row.SampleEventID) {
			row.FirstTime, row.SampleEventID = ev.Time, ev.ID
		}
		if ev.Time.After(row.LastTime) {
			row.LastTime = ev.Time
		}
		e.sessions[ev.SessionID] = row
		ms := e.members[ev.SessionID]
		i := sort.Search(len(ms), func(i int) bool {
			if !ms[i].time.Equal(ev.Time) {
				return ms[i].time.After(ev.Time)
			}
			return ms[i].id >= ev.ID
		})
		if !(i < len(ms) && ms[i].id == ev.ID) {
			ms = append(ms, memberObs{})
			copy(ms[i+1:], ms[i:])
			ms[i] = memberObs{time: ev.Time, id: ev.ID}
			if len(ms) > errorSignatureSessionMembers {
				ms = ms[:errorSignatureSessionMembers]
			}
		}
		e.members[ev.SessionID] = ms
	}
	// A signature ties only to paths its own event carries; no inference from
	// neighbouring events. Keep the set sorted and keep the smallest paths when
	// capped, so the result does not depend on application order.
	for _, p := range EventFilePaths(ev) {
		i := sort.SearchStrings(e.Paths, p)
		if i < len(e.Paths) && e.Paths[i] == p {
			continue
		}
		e.Paths = append(e.Paths, "")
		copy(e.Paths[i+1:], e.Paths[i:])
		e.Paths[i] = p
		if len(e.Paths) > errorSignaturePaths {
			e.Paths = e.Paths[:errorSignaturePaths]
		}
	}
}

// ErrorSignatures returns Error Signature summaries, most recently seen first
// (LastTime desc, then Key asc). An empty sessionID returns every signature;
// otherwise only signatures that include that session, each additionally
// carrying Members: that session's qualifying event ids. Filtering selects
// which signatures appear: Count and Sessions remain global and are not
// re-scoped to the session. The result is never nil.
func (ix *Projection) ErrorSignatures(sessionID string) []ErrorSignature {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]ErrorSignature, 0, len(ix.errSigs))
	for _, e := range ix.errSigs {
		if sessionID != "" && len(e.members[sessionID]) == 0 {
			continue
		}
		sig := e.ErrorSignature
		sig.Sessions = len(e.members)
		if e.Paths != nil {
			sig.Paths = append([]string(nil), e.Paths...)
		}
		if sessionID != "" {
			ms := e.members[sessionID]
			sig.Members = make([]string, len(ms))
			for i, m := range ms {
				sig.Members[i] = m.id
			}
		}
		out = append(out, sig)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return out[i].Key < out[j].Key
	})
	return out
}
