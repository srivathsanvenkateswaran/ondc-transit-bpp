package auth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCapturedWireRequest(t *testing.T) {
	body, err := os.ReadFile("../../phase-1/evidence/auth-replay-request.json")
	if err != nil {
		t.Fatal(err)
	}
	body = bytes.TrimSuffix(body, []byte("\n"))
	publicKey, err := base64.StdEncoding.DecodeString("s4+IalwWNUQN0lypBTqJCAaQXfpXkov85FVIxaQlVg8=")
	if err != nil {
		t.Fatal(err)
	}
	header := `Signature keyId="bap.transit.localhost|bap-transit-key|ed25519",algorithm="ed25519",created="1787212173",expires="1787215773",headers="(created) (expires) digest",signature="PnqUnbN7KqJTh+JYrEDsforutuknUAaPqlKCxPVehIxlvJfHL2kGkKzZ/gbJgcXqLbrmamm6FdrRz2xAVratDA=="`
	got, err := Verify(body, header, publicKey, time.Unix(1787212200, 0), 0)
	if err != nil {
		t.Fatalf("captured signature did not verify: %v", err)
	}
	if got.SubscriberID != "bap.transit.localhost" {
		t.Fatalf("subscriber = %q", got.SubscriberID)
	}

	tampered, err := os.ReadFile("../../phase-1/evidence/auth-tampered-request.json")
	if err != nil {
		t.Fatal(err)
	}
	tampered = bytes.TrimSuffix(tampered, []byte("\n"))
	if _, err := Verify(tampered, header, publicKey, time.Unix(1787212200, 0), 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("tampered request error = %v", err)
	}
}

func TestSignAndVerify(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Unix(1000, 0)
	header, err := Sign([]byte(`{"ok":true}`), "buyer.test", "key-1", privateKey, created, created.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify([]byte(`{"ok":true}`), header, publicKey, created.Add(time.Second), time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestVerificationErrors(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Unix(1000, 0)
	header, err := Sign([]byte("body"), "buyer.test", "key-1", privateKey, created, created.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, header string
		now          time.Time
		key          ed25519.PublicKey
		want         error
	}{
		{"malformed", "Bearer no", created, publicKey, ErrMalformed},
		{"expired", header, created.Add(2 * time.Minute), publicKey, ErrExpired},
		{"future", header, created.Add(-time.Minute), publicKey, ErrNotYetValid},
		{"bad key", header, created, ed25519.PublicKey("short"), ErrInvalidKey},
		{"unknown field", header + `,extra="x"`, created, publicKey, ErrMalformed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, got := Verify([]byte("body"), tt.header, tt.key, tt.now, 0)
			if !errors.Is(got, tt.want) {
				t.Fatalf("error = %v, want %v", got, tt.want)
			}
		})
	}
	if !strings.HasPrefix(Digest(nil), "BLAKE-512=") {
		t.Fatal("digest algorithm missing")
	}
}
