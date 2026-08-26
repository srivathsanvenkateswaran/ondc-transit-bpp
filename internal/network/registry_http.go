package network

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
)

func RegistryHandler(store registry.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /subscribers/lookup", func(w http.ResponseWriter, r *http.Request) {
		var query struct {
			Domain string `json:"domain"`
			Type   string `json:"type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&query); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, 400, err)
			return
		}
		items, err := store.Lookup(r.Context(), query.Domain, query.Type, time.Now())
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, items)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "up"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Ready(r.Context()); err != nil {
			writeError(w, 503, err)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	return mux
}

func (a *App) GatewayHTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /bg/search", func(w http.ResponseWriter, r *http.Request) {
		body, err := a.readBody(r)
		if err != nil {
			writeError(w, 400, err)
			return
		}
		header := r.Header.Get("Authorization")
		if _, err = a.verify(body, header); err != nil {
			writeNACK(w, 401, "Authentication failed")
			return
		}
		env := envelope{Authorization: header, Body: body}
		encoded, _ := json.Marshal(env)
		if err = a.transport.Publish(r.Context(), "gateway.search", encoded); err != nil {
			writeError(w, 503, err)
			return
		}
		writeACK(w, http.StatusAccepted)
	})
	a.health(mux, false)
	return mux
}
