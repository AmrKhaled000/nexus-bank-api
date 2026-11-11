<#
.SYNOPSIS
  One-shot elevated setup for Docker Desktop on Windows (NEXUS BANK local demo stack).

.DESCRIPTION
  Enables the VirtualMachinePlatform optional feature (required by WSL2 and Docker Desktop),
  refreshes WSL, then installs Docker Desktop via winget. Must be run as Administrator;
  automatically re-launches itself elevated when started by an unprivileged user.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-docker-windows.ps1

.NOTES
  A reboot is required after the VirtualMachinePlatform feature is enabled. After reboot:
    1) Start Docker Desktop once and accept the license agreement
    2) cd <repository root>
    3) docker compose --profile demo up --build
    4) curl http://localhost:3000/health/ready   # expect {"ready":true,...}
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Write-Host 'NEXUS BANK - elevated Docker Desktop setup' -ForegroundColor Cyan

# --- 1) Require elevation; re-launch elevated if needed -------------------------------
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Relaunching elevated...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    )
    exit
}

# --- 2) Enable Virtual Machine Platform (Docker Desktop requirement) -------------------
Write-Host 'Enabling VirtualMachinePlatform...' -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null

# --- 3) Refresh the WSL kernel (idempotent) -------------------------------------------
Write-Host 'Updating WSL...' -ForegroundColor Cyan
wsl.exe --update | Out-Null

# --- 4) Install Docker Desktop ---------------------------------------------------------
Write-Host 'Installing Docker Desktop via winget...' -ForegroundColor Cyan
winget install --id Docker.DockerDesktop --exact --silent `
    --accept-source-agreements --accept-package-agreements

Write-Host ''
Write-Host 'Done. Required follow-up steps:' -ForegroundColor Green
Write-Host '  1) REBOOT this machine (VirtualMachinePlatform needs it)'
Write-Host '  2) Launch Docker Desktop once and accept the license'
Write-Host '  3) docker compose --profile demo up --build'
Write-Host '  4) curl http://localhost:3000/health/ready   # {"ready":true,...}'
