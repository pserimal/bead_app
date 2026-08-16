# Output the machine's real LAN IPv4 address (used by start-local.bat to
# open the browser at a LAN-reachable URL).
#
# Filters out virtual adapters (VM/container/loopback/bluetooth) and proxy
# ranges (198.18/15 is a benchmarking range used by proxy tools), then picks
# the lowest InterfaceMetric address (real NICs usually have lower metrics).
try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.IPAddress -notlike '198.18.*' -and
        $_.InterfaceAlias -notmatch 'Virtual|TAP|VMware|VirtualBox|Hyper-V|vEthernet|Loopback|Bluetooth|Tailscale|WSL|Npcap|ZeroTier|WireGuard|Tunnel'
    } | Sort-Object InterfaceMetric | Select-Object -First 1
    if ($ip) { Write-Output $ip.IPAddress }
} catch {
    # fallback: first IPv4 from ipconfig
    $fallback = (ipconfig | Select-String 'IPv4' | Select-Object -First 1) -replace '.*: ', ''
    if ($fallback) { Write-Output $fallback.Trim() }
}
