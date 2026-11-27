package main

import _ "embed"

//go:embed ui/index.html
var uiHTML []byte

//go:embed ui/icon.ico
var iconICO []byte
