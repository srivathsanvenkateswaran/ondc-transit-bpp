package auth

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"
)

var (
	ErrMalformed   = errors.New("malformed signature header")
	ErrExpired     = errors.New("signature has expired")
	ErrNotYetValid = errors.New("signature created outside allowed clock skew")
	ErrInvalid     = errors.New("invalid signature")
	ErrInvalidKey  = errors.New("invalid Ed25519 key")
)

const signedHeaders = "(created) (expires) digest"

type Header struct {
	SubscriberID string
	UniqueKeyID  string
	Algorithm    string
	Created      int64
	Expires      int64
	Headers      string
	Signature    []byte
}

func Digest(body []byte) string {
	sum := blake2b.Sum512(body)
	return "BLAKE-512=" + base64.StdEncoding.EncodeToString(sum[:])
}

func signingString(body []byte, created, expires int64) string {
	return fmt.Sprintf("(created): %d\n(expires): %d\ndigest: %s", created, expires, Digest(body))
}

func Sign(body []byte, subscriberID, uniqueKeyID string, privateKey ed25519.PrivateKey, created, expires time.Time) (string, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return "", ErrInvalidKey
	}
	if subscriberID == "" || uniqueKeyID == "" || !expires.After(created) {
		return "", ErrMalformed
	}
	c, e := created.Unix(), expires.Unix()
	sig := ed25519.Sign(privateKey, []byte(signingString(body, c, e)))
	return fmt.Sprintf(`Signature keyId="%s|%s|ed25519",algorithm="ed25519",created="%d",expires="%d",headers="%s",signature="%s"`, subscriberID, uniqueKeyID, c, e, signedHeaders, base64.StdEncoding.EncodeToString(sig)), nil
}

func Parse(value string) (Header, error) {
	var h Header
	if !strings.HasPrefix(value, "Signature ") {
		return h, ErrMalformed
	}
	fields := make(map[string]string)
	for _, part := range strings.Split(strings.TrimPrefix(value, "Signature "), ",") {
		pair := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(pair) != 2 || len(pair[1]) < 2 || pair[1][0] != '"' || pair[1][len(pair[1])-1] != '"' {
			return h, ErrMalformed
		}
		if _, exists := fields[pair[0]]; exists {
			return h, ErrMalformed
		}
		fields[pair[0]] = pair[1][1 : len(pair[1])-1]
	}
	key := strings.Split(fields["keyId"], "|")
	if len(key) != 3 || key[0] == "" || key[1] == "" || key[2] != "ed25519" {
		return h, ErrMalformed
	}
	created, err := strconv.ParseInt(fields["created"], 10, 64)
	if err != nil {
		return h, ErrMalformed
	}
	expires, err := strconv.ParseInt(fields["expires"], 10, 64)
	if err != nil || expires <= created {
		return h, ErrMalformed
	}
	sig, err := base64.StdEncoding.DecodeString(fields["signature"])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return h, ErrMalformed
	}
	h = Header{SubscriberID: key[0], UniqueKeyID: key[1], Algorithm: fields["algorithm"], Created: created, Expires: expires, Headers: fields["headers"], Signature: sig}
	if h.Algorithm != "ed25519" || h.Headers != signedHeaders || len(fields) != 6 {
		return Header{}, ErrMalformed
	}
	return h, nil
}

func Verify(body []byte, value string, publicKey ed25519.PublicKey, now time.Time, clockSkew time.Duration) (Header, error) {
	h, err := Parse(value)
	if err != nil {
		return Header{}, err
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return Header{}, ErrInvalidKey
	}
	if now.After(time.Unix(h.Expires, 0).Add(clockSkew)) {
		return Header{}, ErrExpired
	}
	if now.Before(time.Unix(h.Created, 0).Add(-clockSkew)) {
		return Header{}, ErrNotYetValid
	}
	expected := ed25519.SignatureSize
	if subtle.ConstantTimeEq(int32(len(h.Signature)), int32(expected)) != 1 || !ed25519.Verify(publicKey, []byte(signingString(body, h.Created, h.Expires)), h.Signature) {
		return Header{}, ErrInvalid
	}
	return h, nil
}
