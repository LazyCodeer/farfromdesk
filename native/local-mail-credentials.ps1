# Local email credential broker for Windows (the counterpart of local-mail-keychain.swift).
#
# One long-lived process per Local backend. Arguments: an absolute lock file path, and, for
# tests only, a synthetic namespace "ffd-test-..." that keeps test items apart from real ones.
# It takes an exclusive lock on the file (no sharing) and holds it until it exits, so no
# second broker, and no credential write, can outlive the backend's view of it. When the
# parent goes away stdin closes, the loop ends and the lock is released by the OS.
#
# Protocol, one UTF-8 JSON object per line:
#   start                                         -> {"ready":true}
#   {"action":"read","slot":"<32 hex>"}           -> {"ok":true,"value":"..."} or {"ok":true,"value":null}
#   {"action":"write","slot":"<32 hex>","value":"..."} -> {"ok":true}   (fails if the slot exists)
#   {"action":"remove","slot":"<32 hex>"}         -> {"ok":true}   (also when absent)
#   anything else                                 -> {"ok":false}
#
# Items are Windows Credential Manager generic credentials named
# "com.codecylabs.farfromdesk.local.email/<slot>", persisted for this user on this PC only
# (CRED_PERSIST_LOCAL_MACHINE, never roaming). Only slot names this broker builds are ever
# read, written or deleted; it cannot enumerate or touch any other credential. Credential
# Manager has no per-app access list like the macOS Keychain: any program running as this
# Windows user can read these items, as with every other saved Windows credential.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class FFDMailCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);

  const uint GENERIC = 1, PERSIST_LOCAL_MACHINE = 2;
  const int NOT_FOUND = 1168;
  const string Service = "com.codecylabs.farfromdesk.local.email";
  static readonly Regex SlotPattern = new Regex("^[a-f0-9]{32}$");
  static readonly Regex TestPattern = new Regex("^ffd-test-[a-z0-9-]{1,40}$");
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static Stream output;

  static void Reply(Dictionary<string, object> value) {
    byte[] data = Utf8.GetBytes(new JavaScriptSerializer().Serialize(value) + "\n");
    if (data.Length > 16385) Environment.Exit(1);
    output.Write(data, 0, data.Length); output.Flush();
  }
  static Dictionary<string, object> Result(bool ok) { Dictionary<string, object> r = new Dictionary<string, object>(); r["ok"] = ok; return r; }

  // Returns true with value null when the item does not exist; false on any other failure.
  static bool Read(string target, out string value) {
    value = null; IntPtr pointer;
    if (!CredReadW(target, GENERIC, 0, out pointer)) return Marshal.GetLastWin32Error() == NOT_FOUND;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0 || c.CredentialBlobSize > 4096 || c.CredentialBlob == IntPtr.Zero) return false;
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      try { value = Utf8.GetString(bytes); } catch (ArgumentException) { return false; } finally { Array.Clear(bytes, 0, bytes.Length); }
      return true;
    } finally { CredFree(pointer); }
  }
  static bool Write(string target, string value) {
    string existing;
    // Like SecItemAdd: a slot is written once. An existing item (or an unreadable one) fails.
    if (!Read(target, out existing) || existing != null) return false;
    byte[] bytes = Utf8.GetBytes(value);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = GENERIC; c.TargetName = target; c.CredentialBlobSize = (uint)bytes.Length; c.CredentialBlob = blob;
      c.Persist = PERSIST_LOCAL_MACHINE; c.UserName = "FarFromDesk Local email";
      return CredWriteW(ref c, 0);
    } finally {
      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
      Marshal.FreeHGlobal(blob); Array.Clear(bytes, 0, bytes.Length);
    }
  }
  static bool Remove(string target) { return CredDeleteW(target, GENERIC, 0) || Marshal.GetLastWin32Error() == NOT_FOUND; }

  public static int Run(string[] args) {
    if (args.Length < 1 || args.Length > 2 || !Path.IsPathRooted(args[0]) || !Path.GetFullPath(args[0]).Equals(args[0], StringComparison.OrdinalIgnoreCase)) return 1;
    string prefix = Service;
    if (args.Length == 2) { if (!TestPattern.IsMatch(args[1])) return 1; prefix = args[1]; }
    // Never follow a link planted where the lock file should be.
    if (File.Exists(args[0]) && (File.GetAttributes(args[0]) & FileAttributes.ReparsePoint) != 0) return 1;
    FileStream lockFile;
    try { lockFile = new FileStream(args[0], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); } catch { return 1; }
    using (lockFile) {
      if ((File.GetAttributes(args[0]) & FileAttributes.ReparsePoint) != 0) return 1;
      output = Console.OpenStandardOutput();
      Dictionary<string, object> ready = new Dictionary<string, object>(); ready["ready"] = true; Reply(ready);
      StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, false));
      JavaScriptSerializer json = new JavaScriptSerializer();
      string line;
      while ((line = input.ReadLine()) != null) {
        Dictionary<string, object> request = null;
        try { if (Utf8.GetByteCount(line) <= 16384) request = json.DeserializeObject(line) as Dictionary<string, object>; } catch { request = null; }
        object actionValue, slotValue;
        if (request == null || !request.TryGetValue("action", out actionValue) || !request.TryGetValue("slot", out slotValue)) { Reply(Result(false)); continue; }
        string action = actionValue as string, slot = slotValue as string;
        bool allStrings = true;
        foreach (object v in request.Values) if (!(v is string)) allStrings = false;
        if (!allStrings || action == null || slot == null || !SlotPattern.IsMatch(slot)) { Reply(Result(false)); continue; }
        string target = prefix + "/" + slot;
        if (action == "read") {
          string value;
          if (Read(target, out value)) { Dictionary<string, object> r = Result(true); r["value"] = value; Reply(r); }
          else Reply(Result(false));
        } else if (action == "write") {
          object raw; string value = request.TryGetValue("value", out raw) ? raw as string : null;
          if (string.IsNullOrEmpty(value) || Utf8.GetByteCount(value) > 4096) { Reply(Result(false)); continue; }
          Reply(Result(Write(target, value)));
        } else if (action == "remove") {
          Reply(Result(Remove(target)));
        } else Reply(Result(false));
      }
    }
    return 0;
  }
}
'@
exit [FFDMailCredentials]::Run([string[]]$args)
