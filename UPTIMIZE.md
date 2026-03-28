$env:UPTIMIZE_TOKEN = "071ee7f2-d95d-4bfb-a5e4-7d81bd83eff6"



Invoke-RestMethod -Method Post `
  -Uri "https://api.nlp.p.uptimize.merckgroup.com/model/eu.anthropic.claude-sonnet-4-20250514-v1:0/invoke" `
  -Headers @{ "api-key" = $env:UPTIMIZE_TOKEN; "Content-Type" = "application/json"; "openai-standard" = "True" } `
  -Body $body



       "eu.anthropic.claude-sonnet-4-6",
        "us.anthropic.claude-sonnet-4-6",
        "eu.anthropic.claude-opus-4-6-v1",

----- NOMIC :

$headers = @{
"Content-Type" = "application/json"
"Authorization" = "Bearer 071ee7f2-d95d-4bfb-a5e4-7d81bd83eff6"
}

$body = '{"input": "How to install IEM Virtual on VMware ESXi", "model": "nomic-embed-text-v1"}'
Invoke-RestMethod -Uri "https://api.nlp.p.uptimize.merckgroup.com/nomic/v1/embeddings" -Method POST -Headers $headers -Body $body | ConvertTo-Json -Depth 3