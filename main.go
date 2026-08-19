package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type Config struct {
	Macros map[string]string `json:"macros"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: squire <macro> [args...]")
		os.Exit(1)
	}

	macroName := os.Args[1]
	args := os.Args[2:]

	// Load configuration
	data, err := os.ReadFile("squire.json")
	if err != nil {
		fmt.Printf("Error: Could not read squire.json in current directory: %v\n", err)
		os.Exit(1)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		fmt.Printf("Error: Could not parse squire.json: %v\n", err)
		os.Exit(1)
	}

	macroCmd, exists := config.Macros[macroName]
	if !exists {
		fmt.Printf("Error: Macro '%s' not found in squire.json\n", macroName)
		os.Exit(1)
	}

	// Substitute $1, $2, etc.
	for i, arg := range args {
		placeholder := fmt.Sprintf("$%d", i+1)
		macroCmd = strings.ReplaceAll(macroCmd, placeholder, arg)
	}

	fmt.Printf("Executing: %s\n", macroCmd)

	// Check if pith is installed to preserve token savings
	var cmd *exec.Cmd
	_, err = exec.LookPath("pith")
	if err == nil {
		// Pith is installed, route the macro through pith
		// Since macros might contain '&&', we use pwsh and wrap it with pith
		cmd = exec.Command("pith", "pwsh", "-Command", macroCmd)
	} else {
		// Fallback to standard execution if pith is optional/missing
		cmd = exec.Command("pwsh", "-Command", macroCmd)
	}

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Run(); err != nil {
		fmt.Printf("Error executing macro: %v\n", err)
		os.Exit(1)
	}
}
