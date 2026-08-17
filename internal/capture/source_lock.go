package capture

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const sourceOwnershipPollInterval = 100 * time.Millisecond

type sourceLease struct {
	path string
	mu   sync.Mutex
	file *os.File
	refs int
}

func (l *sourceLease) claim(ctx context.Context) (func(), error) {
	if l.path == "" {
		return func() {}, nil
	}
	for {
		claimed, err := l.tryClaim()
		if err != nil {
			return nil, err
		}
		if claimed {
			return l.release, nil
		}
		timer := time.NewTimer(sourceOwnershipPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (l *sourceLease) tryClaim() (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		l.refs++
		return true, nil
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return false, fmt.Errorf("capture: create Source ownership directory: %w", err)
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return false, fmt.Errorf("capture: open Source ownership lock: %w", err)
	}
	owned, err := tryLockSourceFile(file)
	if err != nil {
		_ = file.Close()
		return false, fmt.Errorf("capture: lock Sources: %w", err)
	}
	if !owned {
		_ = file.Close()
		return false, nil
	}
	l.file = file
	l.refs = 1
	return true, nil
}

func (l *sourceLease) release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil || l.refs == 0 {
		return
	}
	l.refs--
	if l.refs != 0 {
		return
	}
	_ = unlockSourceFile(l.file)
	_ = l.file.Close()
	l.file = nil
}

type leasedSource struct {
	lease  *sourceLease
	source Source
}

func (s *leasedSource) Name() string { return s.source.Name() }

func (s *leasedSource) Run(ctx context.Context, sink Sink) error {
	release, err := s.lease.claim(ctx)
	if err != nil {
		return err
	}
	defer release()
	if preparer, ok := s.source.(interface{ prepare(Sink) error }); ok {
		if err := preparer.prepare(sink); err != nil {
			return err
		}
	}
	return s.source.Run(ctx, sink)
}
