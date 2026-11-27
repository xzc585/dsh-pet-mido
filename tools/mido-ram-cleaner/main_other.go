//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "米豆系统内存清理只支持 Windows。请交叉编译：")
	fmt.Fprintln(os.Stderr, "  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags=\"-s -w\" -o dist/mido-ram-cleaner.exe .")
	os.Exit(1)
}
