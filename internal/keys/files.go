package keys

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func LoadOrCreate(dir, name string) (ed25519.PrivateKey, error) {
	if dir == "" || name == "" || strings.ContainsAny(name, "/\\") {
		return nil, errors.New("valid key directory and name are required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name+".key")
	data, err := os.ReadFile(path)
	if err == nil {
		return decode(data)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	encoded := []byte(base64.StdEncoding.EncodeToString(privateKey) + "\n")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		data, err = os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return decode(data)
	}
	if err != nil {
		return nil, err
	}
	if _, err = file.Write(encoded); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	return privateKey, nil
}
func decode(data []byte) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(raw) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Ed25519 private key file")
	}
	return ed25519.PrivateKey(raw), nil
}
