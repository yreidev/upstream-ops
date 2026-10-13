package connector

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"testing"
)

func TestHTTPStatusErrorKeepsMessageAndCode(t *testing.T) {
	err := fmt.Errorf("sub2api me: %w", HTTPStatusError(502, []byte(`<html><title>502 Bad Gateway</title></html>`)))
	if got := err.Error(); got != "sub2api me: status 502: 502 Bad Gateway" {
		t.Fatalf("message = %q", got)
	}
	if got := StatusCode(err); got != 502 {
		t.Fatalf("StatusCode = %d, want 502", got)
	}
	if got := HTTPStatusError(404, nil).Error(); got != "status 404" {
		t.Fatalf("empty body message = %q", got)
	}
}

func TestIsTransient(t *testing.T) {
	dnsErr := &url.Error{Op: "Get", URL: "https://example.com", Err: &net.DNSError{Err: "no such host", Name: "example.com"}}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"408", HTTPStatusError(408, nil), true},
		{"429", HTTPStatusError(429, nil), true},
		{"500", HTTPStatusError(500, nil), true},
		{"cloudflare 522", fmt.Errorf("wrap: %w", HTTPStatusError(522, nil)), true},
		{"401", HTTPStatusError(401, nil), false},
		{"403", HTTPStatusError(403, nil), false},
		{"404", HTTPStatusError(404, nil), false},
		{"deadline", fmt.Errorf("x: %w", context.DeadlineExceeded), true},
		{"transport", fmt.Errorf("newapi self: %w", dnsErr), true},
		{"plain", errors.New("token invalid"), false},
	}
	for _, tc := range cases {
		if got := IsTransient(tc.err); got != tc.want {
			t.Errorf("%s: IsTransient = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPermanent(t *testing.T) {
	if Permanent(nil) != nil {
		t.Fatal("Permanent(nil) must be nil")
	}
	base := HTTPStatusError(401, []byte(`{"message":"invalid email or password"}`))
	err := fmt.Errorf("login: %w", Permanent(base))
	if !IsPermanent(err) {
		t.Fatal("wrapped permanent error not detected")
	}
	if StatusCode(err) != 401 {
		t.Fatal("permanent wrapper must keep the status code reachable")
	}
	if err.Error() != "login: status 401: invalid email or password" {
		t.Fatalf("message = %q", err.Error())
	}
	if IsPermanent(base) {
		t.Fatal("plain status error must not be permanent")
	}
}
