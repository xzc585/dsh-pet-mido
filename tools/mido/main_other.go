//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "米豆入口程序只支持 Windows。请在 Windows 上运行交叉编译出的 mido.exe。")
	os.Exit(2)
}
