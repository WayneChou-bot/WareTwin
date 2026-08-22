# 一鍵啟動後端 + 前端（Windows PowerShell）
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$PSScriptRoot\backend'; if (Test-Path .venv) { .\.venv\Scripts\Activate.ps1 }; uvicorn app.main:app --reload --port 8000"
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$PSScriptRoot\frontend'; npm run dev"
