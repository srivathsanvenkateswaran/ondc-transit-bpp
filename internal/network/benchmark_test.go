package network

import (
	"crypto/ed25519"
	"testing"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/auth"
)

func BenchmarkBecknSignAndVerify(b *testing.B) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		b.Fatal(err)
	}
	body := []byte(`{"context":{"domain":"ONDC:TRV11","action":"search","transaction_id":"benchmark","message_id":"benchmark"},"message":{"intent":{}}}`)
	created := time.Unix(2_000_000_000, 0)
	header, err := auth.Sign(body, "bap.benchmark.test", "key-1", privateKey, created, created.Add(time.Minute))
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	b.ResetTimer()
	for range b.N {
		if _, err := auth.Verify(body, header, publicKey, created, 0); err != nil {
			b.Fatal(err)
		}
	}
}
