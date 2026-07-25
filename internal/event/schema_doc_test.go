package event

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The documented schema (docs/event.schema.json) is a frozen platform
// contract; this pins it to the code so neither drifts silently.
func TestSchemaDocMatchesCode(t *testing.T) {
	data, err := os.ReadFile("../../docs/event.schema.json")
	if err != nil {
		t.Fatalf("read schema doc: %v", err)
	}
	var doc struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Enum []string `json:"enum"`
			Type string   `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("schema doc not valid JSON: %v", err)
	}

	docCategories := map[Category]bool{}
	for _, c := range doc.Properties["category"].Enum {
		docCategories[Category(c)] = true
	}
	if len(docCategories) != len(validCategories) {
		t.Errorf("schema doc has %d categories, code has %d", len(docCategories), len(validCategories))
	}
	for c := range validCategories {
		if !docCategories[c] {
			t.Errorf("category %q missing from schema doc", c)
		}
	}

	docSeverities := map[Severity]bool{}
	for _, s := range doc.Properties["severity"].Enum {
		docSeverities[Severity(s)] = true
	}
	if len(docSeverities) != len(validSeverities) {
		t.Errorf("schema doc has %d severities, code has %d", len(docSeverities), len(validSeverities))
	}
	for s := range validSeverities {
		if !docSeverities[s] {
			t.Errorf("severity %q missing from schema doc", s)
		}
	}

	for _, field := range []string{"id", "time", "source", "category"} {
		found := false
		for _, r := range doc.Required {
			if r == field {
				found = true
			}
		}
		if !found {
			t.Errorf("schema doc must require %q", field)
		}
	}

	// Every envelope field must be documented: new struct fields may only
	// ship together with their schema-doc entry (additive evolution rule).
	et := reflect.TypeOf(Event{})
	for i := range et.NumField() {
		tag := strings.Split(et.Field(i).Tag.Get("json"), ",")[0]
		if tag == "" || tag == "-" {
			continue
		}
		if _, ok := doc.Properties[tag]; !ok {
			t.Errorf("envelope field %q missing from schema doc", tag)
		}
	}

	for field, wantType := range map[string]string{
		"upstream_event_id": "string",
		"prompt_id":         "string",
		"message_id":        "string",
		"parent_id":         "string",
		"request_id":        "string",
		"sequence":          "integer",
		"transport":         "string",
		"source_version":    "string",
	} {
		property, ok := doc.Properties[field]
		if !ok {
			t.Errorf("additive capture field %q missing from schema doc", field)
			continue
		}
		if property.Type != wantType {
			t.Errorf("schema property %q type = %q, want %q", field, property.Type, wantType)
		}
	}
}
