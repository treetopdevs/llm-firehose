package capture

import (
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

type contextQuery struct {
	name   string
	query  func(*Engine, context.Context, string) ([]event.Event, error)
	legacy func(*Engine, string) ([]event.Event, error)
}

var historyContextQueries = []contextQuery{
	{"session", (*Engine).SessionContext, (*Engine).Session},
	{"trace", (*Engine).TraceContext, (*Engine).Trace},
}

func TestHistoryContextPrecancelSkipsScans(t *testing.T) {
	for _, q := range historyContextQueries {
		t.Run(q.name, func(t *testing.T) {
			dir := t.TempDir()
			historyFixture(t, dir, "target", "target")
			calls := 0
			e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: func(context.Context, string, string, spool.Prefilter, func(), func(event.Event)) error {
				calls++
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			deadline, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			defer stop()
			for _, ctx := range []context.Context{canceled, deadline} {
				for _, id := range []string{"target", "absent"} {
					got, err := q.query(e, ctx, id)
					if got != nil || !errors.Is(err, ctx.Err()) {
						t.Fatalf("got=%v err=%v want=%v", got, err, ctx.Err())
					}
				}
			}
			if calls != 0 {
				t.Fatalf("canceled queries scanned %d days", calls)
			}
		})
	}
}
func TestHistoryContextStopsBetweenDaysAndDiscardsPartialResults(t *testing.T) {
	for _, q := range historyContextQueries {
		for _, cancelAt := range []int{1, 3} {
			t.Run(fmt.Sprintf("%s/day-%d", q.name, cancelAt), func(t *testing.T) {
				dir := t.TempDir()
				historyFixture(t, dir, "target", "target")
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				calls := 0
				scan := func(got context.Context, dir, day string, filter spool.Prefilter, gap func(), yield func(event.Event)) error {
					calls++
					if got != ctx {
						t.Error("caller context was not forwarded")
					}
					if err := spool.ScanDay(got, dir, day, filter, gap, yield); err != nil {
						return err
					}
					if calls == cancelAt {
						cancel()
					}
					return nil // Cancellation at EOF must not return partial success.
				}
				e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: scan})
				if err != nil {
					t.Fatal(err)
				}
				got, err := q.query(e, ctx, "target")
				if got != nil || !errors.Is(err, context.Canceled) {
					t.Fatalf("got %d events, err=%v", len(got), err)
				}
				if calls != cancelAt {
					t.Fatalf("scanned %d days after cancellation at %d", calls, cancelAt)
				}
			})
		}
	}
}
func TestHistoryContextHealthyMatchesLegacyAndPreservesErrors(t *testing.T) {
	for _, q := range historyContextQueries {
		t.Run(q.name, func(t *testing.T) {
			dir := t.TempDir()
			historyFixture(t, dir, "target", "target")
			e, err := New(Options{SpoolDir: dir, Policy: privacy.ModeFull})
			if err != nil {
				t.Fatal(err)
			}
			got, err := q.query(e, context.Background(), "target")
			if err != nil {
				t.Fatal(err)
			}
			want, err := q.legacy(e, "target")
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("context query differs from legacy: %v", err)
			}
			if _, err = q.query(e, context.Background(), "absent"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing err=%v", err)
			}
			scanErr := errors.New("scan failed")
			broken, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: func(context.Context, string, string, spool.Prefilter, func(), func(event.Event)) error {
				return scanErr
			}})
			if err != nil {
				t.Fatal(err)
			}
			if got, err = q.query(broken, context.Background(), "target"); got != nil || !errors.Is(err, scanErr) {
				t.Fatalf("scan error lost: %v, %v", got, err)
			}
		})
	}
}

func TestHistoryContextCancellationWithoutYieldIsNotNotFound(t *testing.T) {
	for _, q := range historyContextQueries {
		t.Run(q.name, func(t *testing.T) {
			dir := t.TempDir()
			historyFixture(t, dir, "target", "target")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: func(context.Context, string, string, spool.Prefilter, func(), func(event.Event)) error {
				cancel()
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			got, err := q.query(e, ctx, "target")
			if got != nil || !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel without yield returned %v %v", got, err)
			}
		})
	}
}
