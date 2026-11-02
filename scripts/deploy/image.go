package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// imageContent identifies Linux execution configuration and uncompressed layer
// digests across Docker's classic and containerd stores. Their .Id values can
// refer to different objects (config, manifest, or index) after save/load.
type imageContent struct {
	Architecture, Os string
	Config           struct {
		User                                 string
		Env, Entrypoint, Cmd, OnBuild, Shell []string
		WorkingDir, StopSignal               string
		Labels                               map[string]string
		ExposedPorts, Volumes                map[string]struct{}
		ArgsEscaped                          bool
		Healthcheck                          *struct {
			Test                                                   []string
			Interval, Timeout, StartPeriod, StartInterval, Retries int64
		}
	}
	RootFS struct {
		Type   string
		Layers []string
	}
}

func inspectImage(ctx context.Context, image, platform string) (string, string, error) {
	args := []string{"image", "inspect", "--format", "{{json .}}"}
	if platform != "" {
		args = append(args, "--platform", platform)
	}
	args = append(args, image)
	raw, err := output(ctx, "docker", args...)
	if err != nil {
		return "", "", err
	}
	var id struct{ ID string }
	var content imageContent
	if err := json.Unmarshal([]byte(raw), &id); err != nil {
		return "", "", err
	}
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		return "", "", err
	}
	if content.Os != "linux" || len(content.RootFS.Layers) == 0 {
		return "", "", fmt.Errorf("%s is not a Linux application image", image)
	}
	b, err := json.Marshal(content)
	if err != nil {
		return "", "", err
	}
	digest := sha256.Sum256(b)
	return id.ID, "sha256:" + hex.EncodeToString(digest[:]), nil
}
