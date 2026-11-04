package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type githubClient struct {
	base, token string
	client      *http.Client
}

type workflowRun struct {
	ID         int64  `json:"id"`
	RunAttempt int64  `json:"run_attempt"`
	HeadSHA    string `json:"head_sha"`
	Path       string `json:"path"`
	Event      string `json:"event"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	HeadRepo struct {
		FullName string `json:"full_name"`
	} `json:"head_repository"`
	PullRequests []struct {
		Number int64 `json:"number"`
	} `json:"pull_requests"`
}

func (r workflowRun) matches(current record, parent string) bool {
	if r.ID <= 0 || r.RunAttempt <= 0 || r.HeadSHA != parent || strings.Split(r.Path, "@")[0] != workflow || r.Event != "pull_request" ||
		r.Repository.FullName != current.Repository || r.HeadRepo.FullName != current.Repository {
		return false
	}
	for _, pr := range r.PullRequests {
		if pr.Number == current.PR {
			return true
		}
	}
	// Historical runs can lose their live PR association. The immutable record
	// below still has to match the exact PR number before reuse is allowed.
	return len(r.PullRequests) == 0
}

func (c *githubClient) fullRun(ctx context.Context, current record, parent string) (record, error) {
	var empty record
	if c.token == "" {
		return empty, errors.New("Actions read token is unavailable")
	}
	prefix := "/repos/" + current.Repository + "/actions"
	var list struct {
		Total int           `json:"total_count"`
		Runs  []workflowRun `json:"workflow_runs"`
	}
	if err := c.getJSON(ctx, prefix+"/workflows/ci.yaml/runs?event=pull_request&head_sha="+parent+"&per_page=100", &list); err != nil {
		return empty, err
	}
	if list.Total > len(list.Runs) {
		return empty, errors.New("workflow history exceeds the bounded lookup")
	}
	var latest workflowRun
	for _, run := range list.Runs {
		if run.matches(current, parent) && run.ID > latest.ID {
			latest = run
		}
	}
	if latest.ID == 0 {
		return empty, errors.New("no matching PR workflow run")
	}
	runPath := fmt.Sprintf("%s/runs/%d", prefix, latest.ID)
	var run workflowRun
	if err := c.getJSON(ctx, runPath, &run); err != nil {
		return empty, err
	}
	if run.ID != latest.ID || !run.matches(current, parent) || run.Status != "completed" || run.Conclusion != "success" {
		return empty, errors.New("latest workflow attempt has not succeeded")
	}
	name := fmt.Sprintf("full-ci-%d-%d", run.ID, run.RunAttempt)
	var artifacts struct {
		Total int `json:"total_count"`
		Items []struct {
			ID      int64  `json:"id"`
			Name    string `json:"name"`
			Expired bool   `json:"expired"`
			Digest  string `json:"digest"`
		} `json:"artifacts"`
	}
	if err := c.getJSON(ctx, runPath+"/artifacts?name="+url.QueryEscape(name)+"&per_page=100", &artifacts); err != nil {
		return empty, err
	}
	if artifacts.Total != 1 || len(artifacts.Items) != 1 {
		return empty, errors.New("full validation artifact is missing or ambiguous")
	}
	artifact := artifacts.Items[0]
	if artifact.ID <= 0 || artifact.Name != name || artifact.Expired {
		return empty, errors.New("full validation artifact is unavailable")
	}
	raw, err := c.get(ctx, fmt.Sprintf("%s/artifacts/%d/zip", prefix, artifact.ID), 1<<20)
	if err != nil {
		return empty, err
	}
	digest := sha256.Sum256(raw)
	if artifact.Digest != "sha256:"+hex.EncodeToString(digest[:]) {
		return empty, errors.New("full validation artifact digest does not match")
	}
	evidence, err := readEvidence(raw)
	if err != nil {
		return empty, err
	}
	want := current
	want.Mode, want.SourceSHA, want.RunID, want.RunAttempt = "full", parent, run.ID, run.RunAttempt
	want.MergeSHA = evidence.MergeSHA
	if evidence != want || !shaPattern.MatchString(evidence.MergeSHA) {
		return empty, errors.New("full validation artifact does not match this source/base, PR, workflow, and attempt")
	}
	// Do not accept an earlier green attempt if a rerun started during lookup.
	var recheck workflowRun
	if err := c.getJSON(ctx, runPath, &recheck); err != nil {
		return empty, err
	}
	if recheck.ID != run.ID || recheck.RunAttempt != run.RunAttempt || !recheck.matches(current, parent) || recheck.Status != "completed" || recheck.Conclusion != "success" {
		return empty, errors.New("full workflow changed during lookup")
	}
	return evidence, nil
}

func readEvidence(raw []byte) (record, error) {
	var evidence record
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return evidence, errors.New("invalid full validation archive")
	}
	if len(archive.File) != 1 || archive.File[0].Name != "full-validation.json" || archive.File[0].UncompressedSize64 > 16384 {
		return evidence, errors.New("unexpected full validation archive contents")
	}
	file, err := archive.File[0].Open()
	if err != nil {
		return evidence, err
	}
	defer file.Close()
	raw, err = io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(raw) > 16384 {
		return evidence, errors.New("cannot read bounded full validation record")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&evidence); err != nil {
		return evidence, errors.New("invalid full validation record")
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		return evidence, errors.New("trailing full validation record data")
	}
	return evidence, nil
}

func (c *githubClient) getJSON(ctx context.Context, path string, target any) error {
	raw, err := c.get(ctx, path, 4<<20)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return errors.New("invalid GitHub API response")
	}
	return nil
}

func (c *githubClient) get(ctx context.Context, path string, limit int64) ([]byte, error) {
	if c.base == "" {
		c.base = "https://api.github.com"
	}
	request, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(c.base, "/")+path, nil)
	if err != nil {
		return nil, errors.New("invalid GitHub API URL")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	request.Header.Set("Authorization", "Bearer "+c.token)
	client := *c.client
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		req.Header.Del("Authorization")
		if len(via) >= 5 {
			return errors.New("too many artifact redirects")
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		// Signed artifact URLs and credentials must not reach diagnostics.
		return nil, errors.New("GitHub API request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, errors.New("GitHub API response could not be read within its size limit")
	}
	return raw, nil
}
