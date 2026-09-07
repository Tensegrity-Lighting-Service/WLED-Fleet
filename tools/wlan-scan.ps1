# Force a real Wi-Fi scan through the native WLAN API (WlanScan), the way
# NetSpot / inSSIDer do: the card scans all channels for ~2-4 s and Windows'
# network list (netsh wlan show networks) is refreshed, WITHOUT disconnecting.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\wlan-scan.ps1 [-WaitMs 4000]
param([int]$WaitMs = 4000)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WlanNative {
  [DllImport("wlanapi.dll")] public static extern uint WlanOpenHandle(uint clientVersion, IntPtr reserved, out uint negotiatedVersion, out IntPtr clientHandle);
  [DllImport("wlanapi.dll")] public static extern uint WlanCloseHandle(IntPtr clientHandle, IntPtr reserved);
  [DllImport("wlanapi.dll")] public static extern uint WlanEnumInterfaces(IntPtr clientHandle, IntPtr reserved, out IntPtr interfaceList);
  [DllImport("wlanapi.dll")] public static extern uint WlanScan(IntPtr clientHandle, ref Guid interfaceGuid, IntPtr ssid, IntPtr rawData, IntPtr reserved);
  [DllImport("wlanapi.dll")] public static extern void WlanFreeMemory(IntPtr memory);
  // WLAN_INTERFACE_INFO_LIST: dwNumberOfItems, dwIndex, then WLAN_INTERFACE_INFO[] (GUID 16 + WCHAR[256] 512 + state 4 = 532 bytes)
  public static Guid[] Interfaces(IntPtr client) {
    IntPtr list; uint r = WlanEnumInterfaces(client, IntPtr.Zero, out list);
    if (r != 0) throw new Exception("WlanEnumInterfaces " + r);
    try {
      int n = Marshal.ReadInt32(list);
      Guid[] g = new Guid[n];
      for (int i = 0; i < n; i++) {
        byte[] b = new byte[16];
        Marshal.Copy(new IntPtr(list.ToInt64() + 8 + i * 532), b, 0, 16);
        g[i] = new Guid(b);
      }
      return g;
    } finally { WlanFreeMemory(list); }
  }
}
"@

$ver = 0; $h = [IntPtr]::Zero
$r = [WlanNative]::WlanOpenHandle(2, [IntPtr]::Zero, [ref]$ver, [ref]$h)
if ($r -ne 0) { Write-Output ("{""ok"":false,""error"":""WlanOpenHandle " + $r + """}"); exit 1 }
try {
  $ifs = [WlanNative]::Interfaces($h)
  $n = 0
  foreach ($g in $ifs) { $gg = $g; $rr = [WlanNative]::WlanScan($h, [ref]$gg, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero); if ($rr -eq 0) { $n++ } }
  Start-Sleep -Milliseconds $WaitMs
  Write-Output ("{""ok"":true,""interfaces"":" + $ifs.Count + ",""scanned"":" + $n + "}")
} finally { [WlanNative]::WlanCloseHandle($h, [IntPtr]::Zero) | Out-Null }
