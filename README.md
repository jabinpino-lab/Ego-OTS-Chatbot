# EGO OTS Chatbot

A lightweight EGO OTS assistant modeled after the EGO Basic Chatbot. The UI supports chat, description checking, and screenshot upload.

## Source of truth
The API reads the configured Google Doc at runtime:

`https://docs.google.com/document/d/1xh2tOI0oLdCnzeB37u2ESb3yiDPw1Ws2TFQlsHSr7sw/edit`

The Google Doc must be shared so the deployed server can export/read it.

## Environment variable
Set `GEMINI_API_KEY` in Vercel Project Settings → Environment Variables.

## Deploy
Import this repository into Vercel. No build command is required for the static `index.html` + `/api/chat.js` structure.

The chatbot intentionally fetches the latest document text at request time, so updating the Google Doc updates the chatbot's source without editing the repository.