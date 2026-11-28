//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	cleanAuto     = "auto"
	cleanManual   = "manual"
	cleanElevated = "elevated"
)

var errCleanInProgress = errors.New("已有清理任务在进行，请等它完成")

func finishReport(clean func() CleanReport, trigger string) CleanReport {
	rep := clean()
	rep.At = time.Now()
	rep.Trigger = trigger
	return rep
}

func (s *appState) runClean(trigger string) (CleanReport, error) {
	if !s.cleanMu.TryLock() {
		return CleanReport{}, errCleanInProgress
	}
	defer s.cleanMu.Unlock()
	rep := finishReport(s.clean, trigger)
	s.publishClean(rep)
	return rep, nil
}

func (s *appState) publishClean(rep CleanReport) {
	s.mu.Lock()
	s.lastClean = &rep
	enabled := s.cfg.NotifyOnClean
	s.mu.Unlock()
	if enabled && s.notify != nil {
		if title, text, ok := cleanNotice(rep); ok {
			s.notify(title, text)
		}
	}
}

func cleanNotice(rep CleanReport) (title, text string, ok bool) {
	if rep.Error != "" || !rep.WorkingSetsOK && !rep.StandbyCleared ||
		rep.Before.TotalBytes == 0 || rep.After.TotalBytes == 0 {
		return "", "", false
	}
	titles := map[string]string{
		cleanAuto:     "米豆自动清理完成",
		cleanManual:   "米豆手动清理完成",
		cleanElevated: "米豆管理员清理完成",
	}
	title = titles[rep.Trigger]
	if title == "" {
		return "", "", false
	}
	before, after := rep.Before.AvailableBytes, rep.After.AvailableBytes
	text = "可用内存 " + memorySize(before) + " → " + memorySize(after)
	if after > before {
		text += "（增加 " + memorySize(after-before) + "）"
	} else {
		text += "（未增加）"
	}
	return title, text, true
}

func memorySize(bytes uint64) string {
	const mib = 1 << 20
	const gib = 1 << 30
	switch {
	case bytes >= gib:
		return fmt.Sprintf("%.2f GiB", float64(bytes)/gib)
	case bytes >= mib:
		return fmt.Sprintf("%.0f MiB", float64(bytes)/mib)
	case bytes >= 1<<10:
		return fmt.Sprintf("%.0f KiB", float64(bytes)/(1<<10))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

// Each elevated launch has its own result file. The daemon waits for that
// child process to exit, then consumes its file once.
func (s *appState) startElevatedClean(launch func(string) (func() error, error)) error {
	if !s.cleanMu.TryLock() {
		return errCleanInProgress
	}
	var ticket [16]byte
	if _, err := rand.Read(ticket[:]); err != nil {
		s.cleanMu.Unlock()
		return err
	}
	id := hex.EncodeToString(ticket[:])
	path, err := elevatedResultPath(id)
	if err != nil {
		s.cleanMu.Unlock()
		return err
	}
	wait, err := launch("--clean-once " + id)
	if err != nil {
		s.cleanMu.Unlock()
		return err
	}
	go func() {
		defer s.cleanMu.Unlock()
		defer os.Remove(path)
		if err := wait(); err != nil {
			writeAppLog("管理员清理进程等待失败：" + err.Error())
			return
		}
		rep := readCleanReport(path)
		if rep == nil || rep.Trigger != cleanElevated {
			writeAppLog("管理员清理未返回本次结果")
			return
		}
		if err := writeLastCleanFile(*rep); err != nil {
			writeAppLog("保存管理员清理结果失败：" + err.Error())
		}
		s.publishClean(*rep)
	}()
	return nil
}

func runElevatedChild(id string, admin bool, clean func() CleanReport) error {
	if !admin {
		return errors.New("管理员清理需要管理员权限")
	}
	path, err := elevatedResultPath(id)
	if err != nil {
		return err
	}
	rep := finishReport(clean, cleanElevated)
	if err := writeCleanReport(path, rep); err != nil {
		return err
	}
	if rep.Error != "" {
		return errors.New(rep.Error)
	}
	return nil
}

func elevatedResultPath(id string) (string, error) {
	ticket, err := hex.DecodeString(id)
	if err != nil || len(ticket) != 16 {
		return "", errors.New("管理员清理请求编号无效")
	}
	dir, err := appDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "elevated-"+id+".json"), nil
}

func writeLastCleanFile(rep CleanReport) error {
	dir, err := appDir()
	if err != nil {
		return err
	}
	return writeCleanReport(filepath.Join(dir, "last-clean.json"), rep)
}

func writeCleanReport(path string, rep CleanReport) error {
	raw, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	return writeStateFile(path, append(raw, '\n'))
}
