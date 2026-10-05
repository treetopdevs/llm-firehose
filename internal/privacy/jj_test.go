package privacy

import (
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

func TestJJIdentitiesFollowPathPrivacy(t *testing.T) {
	ev := event.Event{JJRepoID: "jj:/private/project/.jj/repo", JJWorkspaceID: "jj:/private/checkout"}
	for _, mode := range []Mode{ModeMinimal, ModeBalanced} {
		got := Redact(ev, mode)
		if got.JJRepoID != digestPath(ev.JJRepoID) || got.JJWorkspaceID != digestPath(ev.JJWorkspaceID) || strings.Contains(got.JJRepoID, "private") {
			t.Fatalf("JJ path leaked in %s: %+v", mode, got)
		}
	}
	if got := Redact(ev, ModeFull); got.JJRepoID != ev.JJRepoID || got.JJWorkspaceID != ev.JJWorkspaceID {
		t.Fatal("full mode changed JJ identity")
	}
}
