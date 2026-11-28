//go:build windows

package main

import (
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"
)

func successfulTestClean() CleanReport {
	const mib = 1 << 20
	return CleanReport{
		At:            time.Now(),
		WorkingSetsOK: true,
		Before:        MemSnap{TotalBytes: 8000 * mib, AvailableBytes: 1000 * mib},
		After:         MemSnap{TotalBytes: 8000 * mib, AvailableBytes: 1250 * mib},
	}
}

func TestCleanNotificationsUseRealSuccessfulReportsOnce(t *testing.T) {
	var titles []string
	cfg := defaultConfig()
	state := &appState{
		cfg:   cfg,
		clean: successfulTestClean,
		notify: func(title, body string) {
			titles = append(titles, title)
			if !strings.Contains(body, "250 MiB") {
				t.Fatalf("notification should give measured memory change: %q", body)
			}
		},
	}
	if rep, err := state.runClean(cleanManual); err != nil || rep.Trigger != cleanManual || len(titles) != 0 {
		t.Fatalf("disabled notification: report=%+v err=%v titles=%v", rep, err, titles)
	}
	state.cfg.NotifyOnClean = true
	state.clean = func() CleanReport {
		rep := successfulTestClean()
		rep.At = time.Unix(1, 0)
		return rep
	}
	for _, trigger := range []string{cleanManual, cleanAuto, cleanElevated} {
		started := time.Now()
		if rep, err := state.runClean(trigger); err != nil || rep.Trigger != trigger ||
			state.lastClean.Trigger != trigger || rep.At.Before(started) {
			t.Fatalf("clean trigger and completion time were not recorded: report=%+v err=%v", rep, err)
		}
	}
	if len(titles) != 3 || !strings.Contains(titles[0], "手动") ||
		!strings.Contains(titles[1], "自动") || !strings.Contains(titles[2], "管理员") {
		t.Fatalf("unexpected notifications: %v", titles)
	}
	state.clean = func() CleanReport {
		rep := successfulTestClean()
		rep.Error = "access denied"
		return rep
	}
	if rep, err := state.runClean(cleanManual); err != nil || rep.Error == "" || len(titles) != 3 {
		t.Fatalf("failed clean notified or lost error: report=%+v err=%v titles=%v", rep, err, titles)
	}
}

func TestCleanNotificationAvoidsClaimingIncrease(t *testing.T) {
	rep := successfulTestClean()
	rep.Trigger = cleanAuto
	for _, bytes := range []uint64{rep.Before.AvailableBytes, rep.Before.AvailableBytes - 1<<20} {
		rep.After.AvailableBytes = bytes
		if _, body, ok := cleanNotice(rep); !ok || !strings.Contains(body, "未增加") || strings.Contains(body, "释放") {
			t.Fatalf("notification must describe a non-increase: %q, %v", body, ok)
		}
	}
	rep.After = MemSnap{}
	if _, _, ok := cleanNotice(rep); ok {
		t.Fatal("a missing memory snapshot is not a successful result")
	}
}

func TestElevatedCleanOnlyConsumesItsResultOnce(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	cfg := defaultConfig()
	cfg.NotifyOnClean = true
	state := &appState{cfg: cfg, clean: successfulTestClean}
	var notifications int
	state.notify = func(string, string) { notifications++ }

	// An unrelated old result must never be mistaken for a new completion.
	stale := successfulTestClean()
	stale.Trigger = cleanElevated
	if err := writeLastCleanFile(stale); err != nil {
		t.Fatal(err)
	}
	state.lastClean = &stale

	var release sync.WaitGroup
	release.Add(1)
	err := state.startElevatedClean(func(args string) (func() error, error) {
		id, ok := strings.CutPrefix(args, "--clean-once ")
		if !ok {
			t.Fatalf("launch did not carry one-shot request id: %q", args)
		}
		return func() error {
			release.Wait()
			return runElevatedChild(id, true, successfulTestClean)
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := state.runClean(cleanManual); err != errCleanInProgress {
		t.Fatalf("manual clean was not excluded during elevation: %v", err)
	}
	release.Done()
	state.cleanMu.Lock()
	state.cleanMu.Unlock()
	if notifications != 1 || state.lastClean == &stale || state.lastClean.Trigger != cleanElevated {
		t.Fatalf("elevated result wrong: report=%+v notifications=%d", state.lastClean, notifications)
	}
	fresh := state.lastClean

	if err := state.startElevatedClean(func(string) (func() error, error) {
		return func() error { return nil }, nil
	}); err != nil {
		t.Fatal(err)
	}
	state.cleanMu.Lock()
	state.cleanMu.Unlock()
	if notifications != 1 || state.lastClean != fresh {
		t.Fatalf("unmatched old result reprocessed: report=%+v notifications=%d", state.lastClean, notifications)
	}
}

func TestElevatedChildRejectsInvalidOrNonAdminRequestBeforeCleaning(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	for _, request := range []struct {
		id    string
		admin bool
	}{
		{"../../config", true},
		{strings.Repeat("a", 32), false},
	} {
		cleaned := false
		err := runElevatedChild(request.id, request.admin, func() CleanReport {
			cleaned = true
			return CleanReport{}
		})
		if err == nil || cleaned {
			t.Fatalf("invalid child attempted a clean: %+v err=%v", request, err)
		}
	}
}

func TestUpdateConfigPersistsPreferencesFromAnOlderClient(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	state := &appState{cfg: defaultConfig()}
	if err := state.updateConfig(strings.NewReader(`{"showUsage":false,"notifyOnClean":true}`)); err != nil {
		t.Fatal(err)
	}
	if err := state.updateConfig(strings.NewReader(`{"autoClean":false,"intervalSec":900,"thresholdPercent":75,"debounceSec":90}`)); err != nil {
		t.Fatal(err)
	}
	got := loadConfig()
	if got != state.cfg || got.ShowUsage || !got.NotifyOnClean {
		t.Fatalf("saved config did not match active preferences: %+v", got)
	}
}

func TestNativeShellDataLayoutOnAMD64(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("layout verified against 64-bit Windows")
	}
	var balloon notifyIconData
	if unsafe.Sizeof(balloon) != 976 || unsafe.Offsetof(balloon.Info) != 304 || unsafe.Offsetof(balloon.InfoTitle) != 820 {
		t.Fatalf("unexpected NOTIFYICONDATAW layout: size=%d info=%d title=%d",
			unsafe.Sizeof(balloon), unsafe.Offsetof(balloon.Info), unsafe.Offsetof(balloon.InfoTitle))
	}
	var launch shellExecuteInfo
	if unsafe.Sizeof(launch) != 112 || unsafe.Offsetof(launch.Process) != 104 {
		t.Fatalf("unexpected SHELLEXECUTEINFOW layout: size=%d process=%d",
			unsafe.Sizeof(launch), unsafe.Offsetof(launch.Process))
	}
}
