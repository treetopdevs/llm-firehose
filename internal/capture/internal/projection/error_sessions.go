package projection

import (
	"sort"
	"time"
)

// ErrorSession holds exact aggregates for one signature within one session.
// Its sample is the earliest (Time, ID) qualifying Captured Event.
type ErrorSession struct {
	SessionID     string    `json:"session_id"`
	Source        string    `json:"source"`
	Count         int       `json:"count"`
	FirstTime     time.Time `json:"first_time"`
	LastTime      time.Time `json:"last_time"`
	SampleEventID string    `json:"sample_event_id"`
}

// ErrorSessionsPage is a fresh snapshot; arrivals may move rows between pages.
type ErrorSessionsPage struct {
	Key      string         `json:"key"`
	Total    int            `json:"total"`
	Offset   int            `json:"offset"`
	Limit    int            `json:"limit"`
	Sessions []ErrorSession `json:"sessions"`
}

// ErrorSessions copies aggregate values and pages by latest matching observation
// descending, then session ID ascending. The caller validates paging bounds.
func (ix *Projection) ErrorSessions(key string, offset, limit int) (ErrorSessionsPage, bool) {
	page := ErrorSessionsPage{Key: key, Offset: offset, Limit: limit, Sessions: []ErrorSession{}}
	ix.mu.RLock()
	entry, ok := ix.errSigs[key]
	if !ok {
		ix.mu.RUnlock()
		return page, false
	}
	page.Total = len(entry.sessions)
	rows := make([]ErrorSession, 0, page.Total)
	for _, row := range entry.sessions {
		rows = append(rows, row)
	}
	ix.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool {
		if !rows[i].LastTime.Equal(rows[j].LastTime) {
			return rows[i].LastTime.After(rows[j].LastTime)
		}
		return rows[i].SessionID < rows[j].SessionID
	})
	if offset >= 0 && offset < len(rows) && limit > 0 {
		end := len(rows)
		if limit < end-offset {
			end = offset + limit
		}
		page.Sessions = rows[offset:end]
	}
	return page, true
}
