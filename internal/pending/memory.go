package pending

import (
	"context"
	"sync"
	"time"
)

type memoryEntry struct {
	expires   time.Time
	callbacks [][]byte
	changed   chan struct{}
}

type MemoryStore struct {
	mu      sync.Mutex
	entries map[string]*memoryEntry
	closed  bool
	now     func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{entries: make(map[string]*memoryEntry), now: time.Now}
}

func (s *MemoryStore) Claim(_ context.Context, id string, ttl time.Duration) error {
	if id == "" || ttl <= 0 {
		return ErrExpired
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(id)
	if _, ok := s.entries[id]; ok {
		return ErrClaimed
	}
	s.entries[id] = &memoryEntry{expires: s.now().Add(ttl), changed: make(chan struct{})}
	return nil
}

func (s *MemoryStore) Append(_ context.Context, id string, callback []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pruneLocked(id) {
		return ErrExpired
	}
	e, ok := s.entries[id]
	if !ok {
		return ErrNotFound
	}
	e.callbacks = append(e.callbacks, append([]byte(nil), callback...))
	close(e.changed)
	e.changed = make(chan struct{})
	return nil
}

func (s *MemoryStore) Await(ctx context.Context, id string, count int) ([][]byte, error) {
	if count < 1 {
		return nil, ErrNotFound
	}
	for {
		s.mu.Lock()
		if s.pruneLocked(id) {
			s.mu.Unlock()
			return nil, ErrExpired
		}
		e, ok := s.entries[id]
		if !ok {
			s.mu.Unlock()
			return nil, ErrNotFound
		}
		if len(e.callbacks) >= count {
			out := cloneCallbacks(e.callbacks)
			s.mu.Unlock()
			return out, nil
		}
		changed, expires := e.changed, e.expires
		s.mu.Unlock()
		timer := time.NewTimer(time.Until(expires))
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, ctx.Err()
		case <-changed:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
			return nil, ErrExpired
		}
	}
}

func (s *MemoryStore) Release(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok {
		return ErrNotFound
	}
	delete(s.entries, id)
	close(e.changed)
	return nil
}

func (s *MemoryStore) Ready(context.Context) error { return nil }

func (s *MemoryStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	for id, e := range s.entries {
		delete(s.entries, id)
		close(e.changed)
	}
	return nil
}

func (s *MemoryStore) pruneLocked(id string) bool {
	e, ok := s.entries[id]
	if ok && !s.now().Before(e.expires) {
		delete(s.entries, id)
		close(e.changed)
		return true
	}
	return false
}

func cloneCallbacks(in [][]byte) [][]byte {
	out := make([][]byte, len(in))
	for i := range in {
		out[i] = append([]byte(nil), in[i]...)
	}
	return out
}
