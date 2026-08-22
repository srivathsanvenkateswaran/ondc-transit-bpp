package pending

import (
	"context"
	"errors"
	"testing"
	"time"
)

func runStoreSuite(t *testing.T, makeStore func(t *testing.T) Store) {
	t.Helper()
	t.Run("collects across handles", func(t *testing.T) {
		s := makeStore(t)
		defer s.Close()
		ctx := context.Background()
		if err := s.Claim(ctx, "search-1", time.Second); err != nil {
			t.Fatal(err)
		}
		result := make(chan [][]byte, 1)
		go func() { got, _ := s.Await(ctx, "search-1", 2); result <- got }()
		if err := s.Append(ctx, "search-1", []byte("one")); err != nil {
			t.Fatal(err)
		}
		if err := s.Append(ctx, "search-1", []byte("two")); err != nil {
			t.Fatal(err)
		}
		got := <-result
		if len(got) != 2 || string(got[0]) != "one" || string(got[1]) != "two" {
			t.Fatalf("callbacks = %q", got)
		}
		if err := s.Release(ctx, "search-1"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("claim is exclusive", func(t *testing.T) {
		s := makeStore(t)
		defer s.Close()
		if err := s.Claim(context.Background(), "x", time.Second); err != nil {
			t.Fatal(err)
		}
		if err := s.Claim(context.Background(), "x", time.Second); !errors.Is(err, ErrClaimed) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("expires", func(t *testing.T) {
		s := makeStore(t)
		defer s.Close()
		if err := s.Claim(context.Background(), "short", 5*time.Millisecond); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
		if _, err := s.Await(context.Background(), "short", 1); !errors.Is(err, ErrExpired) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestMemoryStoreSuite(t *testing.T) {
	runStoreSuite(t, func(*testing.T) Store { return NewMemoryStore() })
}
