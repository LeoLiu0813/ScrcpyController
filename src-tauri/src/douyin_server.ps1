$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -TypeDefinition @'
public static class DouyinDexChecksum {
    public static uint Adler32(byte[] data, int offset) {
        uint a = 1, b = 0;
        for (int i = offset; i < data.Length; i++) {
            a = (a + data[i]) % 65521;
            b = (b + a) % 65521;
        }
        return (b << 16) | a;
    }
}
'@
$archive = [IO.Compression.ZipFile]::Open($env:SCRCPY_DOUYIN_SERVER, 'Update')
try {
    $entry = $archive.GetEntry('classes.dex')
    $buffer = New-Object IO.MemoryStream
    $stream = $entry.Open()
    try { $stream.CopyTo($buffer) } finally { $stream.Dispose() }
    $dex = $buffer.ToArray()
    $buffer.Dispose()

    # The pinned 5.0.1 DEX loads the display flags with and without destroy-on-close.
    # Clear only the presentation bit in both branches.
    $offset = 0x5525c
    if ([BitConverter]::ToString($dex, $offset, 4) -ne '13-01-CB-01' -or
        [BitConverter]::ToString($dex, ($offset + 6), 4) -ne '13-01-CB-00') {
        throw 'Unexpected virtual display instructions'
    }
    $dex[$offset + 2] = 0xc9
    $dex[$offset + 8] = 0xc9

    # Recompute the DEX header signature and checksum.
    $sha = [Security.Cryptography.SHA1]::Create()
    try {
        $signature = $sha.ComputeHash($dex, 32, $dex.Length - 32)
        [Array]::Copy($signature, 0, $dex, 12, 20)
    } finally { $sha.Dispose() }
    $checksum = [BitConverter]::GetBytes([DouyinDexChecksum]::Adler32($dex, 12))
    [Array]::Copy($checksum, 0, $dex, 8, 4)

    $entry.Delete()
    $stream = $archive.CreateEntry('classes.dex').Open()
    try { $stream.Write($dex, 0, $dex.Length) } finally { $stream.Dispose() }
} finally {
    $archive.Dispose()
}
