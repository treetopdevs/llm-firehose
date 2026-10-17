package projection

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// syntheticFixtures are real, sanitized spool records reused as templates for
// a large synthetic spool (see internal/capture/testdata/README.md).
var syntheticFixtures = []string{
	"../../testdata/activity_real_shapes.ndjson",
	"../../testdata/activity_apply_patch_shapes.ndjson",
	"testdata/errsig.ndjson",
}

// writeSyntheticSpool writes days day files of perDay records each, cycling
// the fixture templates with fresh ids, sessions and times. It never touches
// the live spool.
func writeSyntheticSpool(tb testing.TB, dir string, days, perDay int) {
	tb.Helper()
	var templates []map[string]any
	for _, path := range syntheticFixtures {
		f, err := os.Open(path)
		if err != nil {
			tb.Fatal(err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
				tb.Fatalf("%s: %v", path, err)
			}
			templates = append(templates, m)
		}
		f.Close()
	}
	start := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	n := 0
	for d := 0; d < days; d++ {
		day := start.AddDate(0, 0, d)
		f, err := os.Create(filepath.Join(dir, day.Format("2006-01-02")+".ndjson"))
		if err != nil {
			tb.Fatal(err)
		}
		w := bufio.NewWriter(f)
		for i := 0; i < perDay; i++ {
			m := templates[n%len(templates)]
			t := day.Add(time.Duration(i) * (24 * time.Hour / time.Duration(perDay)))
			m["id"] = fmt.Sprintf("%032x", n)
			m["time"] = t.Format(time.RFC3339Nano)
			m["capture_time"] = m["time"]
			if _, ok := m["session_id"]; ok {
				m["session_id"] = fmt.Sprintf("session-%d", (n/50)%2000)
			}
			if _, ok := m["trace_id"]; ok {
				m["trace_id"] = fmt.Sprintf("trace-%d", n/20)
			}
			line, err := json.Marshal(m)
			if err != nil {
				tb.Fatal(err)
			}
			w.Write(line)
			w.WriteByte('\n')
			n++
		}
		if err := w.Flush(); err != nil {
			tb.Fatal(err)
		}
		f.Close()
	}
}

func BenchmarkBuild(b *testing.B) {
	dir := b.TempDir()
	writeSyntheticSpool(b, dir, 10, 10000)
	b.ReportAllocs()
	b.ResetTimer()
	var heapSys, heapInuse uint64
	for i := 0; i < b.N; i++ {
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)
		ix, err := Build(dir)
		if err != nil {
			b.Fatal(err)
		}
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		heapSys = after.HeapSys
		heapInuse = after.HeapInuse
		runtime.KeepAlive(ix)
	}
	b.ReportMetric(float64(heapSys)/(1<<20), "HeapSys-MiB")
	b.ReportMetric(float64(heapInuse)/(1<<20), "HeapInuse-MiB")
}
