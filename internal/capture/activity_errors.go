package capture

import "sort"

type activityPathKey struct{ group, path string }

// ActivityErrorSignature counts one canonical signature in the requested window.
type ActivityErrorSignature struct {
	Key    string   `json:"key"`
	Total  int      `json:"total"`
	Counts [][2]int `json:"counts"`
}

// ActivityErrorPath is independent of Heat, so error-only paths remain visible.
type ActivityErrorPath struct {
	Path              string                   `json:"path"`
	Group             string                   `json:"group"`
	Total             int                      `json:"total"`
	Signatures        []ActivityErrorSignature `json:"signatures"`
	OmittedSignatures int                      `json:"omitted_signatures"`
}

func activityErrorPaths(counts map[activityPathKey]map[string]map[int]int) ([]ActivityErrorPath, int) {
	out := make([]ActivityErrorPath, 0, len(counts))
	for k, signatures := range counts {
		p := ActivityErrorPath{Path: k.path, Group: k.group}
		for key, buckets := range signatures {
			s := ActivityErrorSignature{Key: key, Counts: make([][2]int, 0, len(buckets))}
			for bucket, n := range buckets {
				s.Total += n
				s.Counts = append(s.Counts, [2]int{bucket, n})
			}
			sort.Slice(s.Counts, func(i, j int) bool { return s.Counts[i][0] < s.Counts[j][0] })
			p.Total += s.Total
			p.Signatures = append(p.Signatures, s)
		}
		sort.Slice(p.Signatures, func(i, j int) bool {
			a, b := p.Signatures[i], p.Signatures[j]
			if a.Total != b.Total {
				return a.Total > b.Total
			}
			return a.Key < b.Key
		})
		if len(p.Signatures) > 20 {
			p.OmittedSignatures = len(p.Signatures) - 20
			p.Signatures = p.Signatures[:20]
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Total != b.Total {
			return a.Total > b.Total
		}
		if a.Group != b.Group {
			return a.Group < b.Group
		}
		return a.Path < b.Path
	})
	omitted := 0
	if len(out) > ActivityPathCap {
		omitted = len(out) - ActivityPathCap
		out = out[:ActivityPathCap]
	}
	return out, omitted
}
