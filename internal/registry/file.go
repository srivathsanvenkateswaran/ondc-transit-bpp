package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type fileState struct {
	Subscribers map[string][]Subscriber `json:"subscribers"`
	Audit       []AuditEvent            `json:"audit"`
}

type FileStore struct {
	mu    sync.RWMutex
	path  string
	state fileState
}

func NewFileStore(path string) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("registry file path is required")
	}
	s := &FileStore{path: path, state: fileState{Subscribers: make(map[string][]Subscriber)}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("decode registry: %w", err)
	}
	if s.state.Subscribers == nil {
		s.state.Subscribers = make(map[string][]Subscriber)
	}
	return s, nil
}

func (s *FileStore) Put(_ context.Context, actor string, sub Subscriber) error {
	if sub.ID == "" || sub.KeyID == "" || sub.URI == "" || sub.PublicKey == "" || !sub.ValidTo.After(sub.ValidFrom) {
		return errors.New("invalid subscriber")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	versions := s.state.Subscribers[sub.ID]
	var before *Subscriber
	for i := len(versions) - 1; i >= 0; i-- {
		if versions[i].KeyID == sub.KeyID {
			b := versions[i]
			before = &b
			break
		}
	}
	s.state.Subscribers[sub.ID] = append(versions, sub)
	s.state.Audit = append(s.state.Audit, AuditEvent{At: time.Now().UTC(), Actor: actor, Operation: "put", Before: before, After: &sub})
	if err := s.persistLocked(); err != nil {
		s.state.Subscribers[sub.ID] = versions
		s.state.Audit = s.state.Audit[:len(s.state.Audit)-1]
		return err
	}
	return nil
}

func (s *FileStore) Get(_ context.Context, id, keyID string, at time.Time) (Subscriber, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	versions := s.state.Subscribers[id]
	for i := len(versions) - 1; i >= 0; i-- {
		v := versions[i]
		if v.KeyID == keyID && !at.Before(v.ValidFrom) && at.Before(v.ValidTo) && v.Status == "SUBSCRIBED" {
			return v, nil
		}
	}
	return Subscriber{}, ErrNotFound
}

func (s *FileStore) Lookup(_ context.Context, domain, typ string, at time.Time) ([]Subscriber, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Subscriber
	for _, versions := range s.state.Subscribers {
		for i := len(versions) - 1; i >= 0; i-- {
			v := versions[i]
			if v.Domain == domain && v.Type == typ && v.Status == "SUBSCRIBED" && !at.Before(v.ValidFrom) && at.Before(v.ValidTo) {
				out = append(out, v)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (s *FileStore) History(_ context.Context, id string) ([]Subscriber, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Subscriber(nil), s.state.Subscribers[id]...), nil
}
func (s *FileStore) Audit(_ context.Context, limit int) ([]AuditEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > len(s.state.Audit) {
		limit = len(s.state.Audit)
	}
	start := len(s.state.Audit) - limit
	return append([]AuditEvent(nil), s.state.Audit[start:]...), nil
}
func (s *FileStore) Ready(context.Context) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.Subscribers == nil {
		return errors.New("registry is not initialized")
	}
	return nil
}
func (s *FileStore) Close() error { return nil }

func (s *FileStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".registry-*.json")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err = enc.Encode(s.state); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Chmod(name, 0o640); err != nil {
		return err
	}
	return os.Rename(name, s.path)
}
