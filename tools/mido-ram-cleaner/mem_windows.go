//go:build windows

package main

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	systemMemoryListInformation = 80

	memoryEmptyWorkingSets            = 2
	memoryPurgeStandbyList            = 4
	memoryPurgeLowPriorityStandbyList = 5

	processSetQuota                = 0x0100
	processQueryLimitedInformation = 0x1000
)

var (
	modpsapi  = windows.NewLazySystemDLL("psapi.dll")
	modntdll  = windows.NewLazySystemDLL("ntdll.dll")
	modkernel = windows.NewLazySystemDLL("kernel32.dll")

	procEmptyWorkingSet        = modpsapi.NewProc("EmptyWorkingSet")
	procNtSetSystemInformation = modntdll.NewProc("NtSetSystemInformation")
	procGlobalMemoryStatusEx   = modkernel.NewProc("GlobalMemoryStatusEx")
	procK32EmptyWorkingSet     = modkernel.NewProc("K32EmptyWorkingSet")
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// MemSnap is a point-in-time view of physical RAM.
type MemSnap struct {
	TotalBytes     uint64  `json:"totalBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

// CleanReport describes one cleanup attempt.
type CleanReport struct {
	At               time.Time `json:"at"`
	Trigger          string    `json:"trigger,omitempty"`
	IsAdmin          bool      `json:"isAdmin"`
	WorkingSetsOK    bool      `json:"workingSetsOK"`
	StandbyCleared   bool      `json:"standbyCleared"`
	StandbySkipped   string    `json:"standbySkipped,omitempty"`
	ProcessesTrimmed int       `json:"processesTrimmed"`
	ProcessesFailed  int       `json:"processesFailed"`
	Before           MemSnap   `json:"before"`
	After            MemSnap   `json:"after"`
	Error            string    `json:"error,omitempty"`
}

func readMemory() (MemSnap, error) {
	var st memoryStatusEx
	st.Length = uint32(unsafe.Sizeof(st))
	r, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&st)))
	if r == 0 {
		if err != nil && err != windows.ERROR_SUCCESS {
			return MemSnap{}, err
		}
		return MemSnap{}, fmt.Errorf("GlobalMemoryStatusEx 失败")
	}
	used := st.TotalPhys - st.AvailPhys
	pct := 0.0
	if st.TotalPhys > 0 {
		pct = float64(used) * 100 / float64(st.TotalPhys)
	}
	return MemSnap{
		TotalBytes:     st.TotalPhys,
		AvailableBytes: st.AvailPhys,
		UsedBytes:      used,
		UsedPercent:    pct,
	}, nil
}

func isAdmin() bool {
	token, err := currentToken()
	if err != nil {
		return false
	}
	defer token.Close()
	return token.IsElevated()
}

func currentToken() (windows.Token, error) {
	var token windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		// GetCurrentProcess returns a pseudo-handle and a nil error in recent x/sys,
		// but keep a fallback.
		proc = windows.CurrentProcess()
	}
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES, &token); err != nil {
		return 0, err
	}
	return token, nil
}

func enablePrivileges() {
	token, err := currentToken()
	if err != nil {
		return
	}
	defer token.Close()
	for _, name := range []string{
		"SeDebugPrivilege",
		"SeIncreaseQuotaPrivilege",
		"SeProfileSingleProcessPrivilege",
	} {
		var luid windows.LUID
		if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid); err != nil {
			continue
		}
		tp := windows.Tokenprivileges{
			PrivilegeCount: 1,
			Privileges: [1]windows.LUIDAndAttributes{{
				Luid:       luid,
				Attributes: windows.SE_PRIVILEGE_ENABLED,
			}},
		}
		_ = windows.AdjustTokenPrivileges(token, false, &tp, 0, nil, nil)
	}
}

func emptyWorkingSet(handle windows.Handle) error {
	if procK32EmptyWorkingSet.Find() == nil {
		r, _, err := procK32EmptyWorkingSet.Call(uintptr(handle))
		if r != 0 {
			return nil
		}
		if err != nil && err != windows.ERROR_SUCCESS {
			return err
		}
	}
	r, _, err := procEmptyWorkingSet.Call(uintptr(handle))
	if r != 0 {
		return nil
	}
	if err != nil && err != windows.ERROR_SUCCESS {
		return err
	}
	return fmt.Errorf("EmptyWorkingSet 失败")
}

func trimProcessWorkingSets() (trimmed, failed int) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, 0
	}
	defer windows.CloseHandle(snap)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snap, &entry); err != nil {
		return 0, 0
	}
	for {
		pid := entry.ProcessID
		if pid != 0 && pid != 4 {
			access := uint32(processSetQuota | processQueryLimitedInformation)
			h, err := windows.OpenProcess(access, false, pid)
			if err != nil {
				h, err = windows.OpenProcess(processSetQuota|windows.PROCESS_QUERY_INFORMATION, false, pid)
			}
			if err == nil {
				if emptyWorkingSet(h) == nil {
					trimmed++
				} else {
					failed++
				}
				windows.CloseHandle(h)
			} else {
				failed++
			}
		}
		if err := windows.Process32Next(snap, &entry); err != nil {
			break
		}
	}
	return trimmed, failed
}

func ntPurge(command uint32) error {
	r, _, callErr := procNtSetSystemInformation.Call(
		uintptr(systemMemoryListInformation),
		uintptr(unsafe.Pointer(&command)),
		unsafe.Sizeof(command),
	)
	if r != 0 {
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return fmt.Errorf("NtSetSystemInformation 0x%X: %v", r, callErr)
		}
		return fmt.Errorf("NtSetSystemInformation 返回 0x%X", r)
	}
	return nil
}

// cleanMemory reclaims working sets always, and the standby list when elevated.
// It never terminates other processes.
func cleanMemory() CleanReport {
	rep := CleanReport{At: time.Now(), IsAdmin: isAdmin()}
	before, err := readMemory()
	if err != nil {
		rep.Error = "无法读取内存状态：" + err.Error()
		return rep
	}
	rep.Before = before

	enablePrivileges()

	// Prefer the system-wide command when possible, then still walk processes
	// so unelevated sessions can trim whatever they can reach.
	if err := ntPurge(memoryEmptyWorkingSets); err == nil {
		rep.WorkingSetsOK = true
	}
	trimmed, failed := trimProcessWorkingSets()
	rep.ProcessesTrimmed = trimmed
	rep.ProcessesFailed = failed
	if trimmed > 0 {
		rep.WorkingSetsOK = true
	}

	if rep.IsAdmin {
		low := ntPurge(memoryPurgeLowPriorityStandbyList)
		all := ntPurge(memoryPurgeStandbyList)
		if all == nil || low == nil {
			rep.StandbyCleared = true
			if all != nil {
				rep.StandbySkipped = "已清空低优先级待机列表，完整待机列表未能清空。"
			}
		} else {
			rep.StandbySkipped = "未能清空待机列表（可能缺少特权）：" + all.Error()
		}
	} else {
		rep.StandbySkipped = "未清空待机列表（需要管理员权限）"
	}

	// Give the accounting a brief moment to settle.
	time.Sleep(200 * time.Millisecond)
	after, err := readMemory()
	if err != nil {
		rep.After = before
		if rep.Error == "" {
			rep.Error = "清理后无法读取内存状态：" + err.Error()
		}
		return rep
	}
	rep.After = after
	if !rep.WorkingSetsOK && !rep.StandbyCleared && rep.Error == "" {
		rep.Error = "这次没有回收到可释放的内存。可能是权限不足，或当前没有多少可收缩的工作集。"
	}
	return rep
}
