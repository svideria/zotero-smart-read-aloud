param(
    [Parameter(Mandatory)][string]$Mode,
    [string]$TextFile,
    [string]$OutFile,
    [string]$VoiceName,
    [double]$Rate = 1.0
)

$ErrorActionPreference = 'Stop'

[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

if ($Mode -eq 'list') {
    [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
        "$($_.DisplayName)`t$($_.Language)`t$($_.Gender)"
    }
    exit 0
}

if ($Mode -eq 'synth') {
    if (-not $TextFile -or -not $OutFile) { Write-Error "Need -TextFile and -OutFile"; exit 1 }
    $Text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)

    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' -ErrorAction SilentlyContinue
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function Await($op, $type) {
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $task = $asTask.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    if ($VoiceName) {
        $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
            Where-Object { $_.DisplayName -eq $VoiceName } | Select-Object -First 1
        if (-not $voice) {
            $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
                Where-Object { $_.DisplayName -like "*$VoiceName*" } | Select-Object -First 1
        }
        if ($voice) { $synth.Voice = $voice }
    }

    $r = [math]::Max(0.5, [math]::Min(6.0, $Rate))
    $synth.Options.SpeakingRate = $r

    $stream = Await ($synth.SynthesizeTextToStreamAsync($Text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $size = $stream.Size
    $inputStream = $stream.GetInputStreamAt(0)
    $reader = New-Object Windows.Storage.Streams.DataReader $inputStream
    [void] (Await ($reader.LoadAsync($size)) ([uint32]))
    $buffer = New-Object byte[] $size
    $reader.ReadBytes($buffer)
    [System.IO.File]::WriteAllBytes($OutFile, $buffer)
    Write-Host "OK $size"
    exit 0
}
