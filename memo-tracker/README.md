# Memo Tracker

A local-first tool for tracking memorandum work: files, redactions, memo versions, deadlines and fees, plus a
citation checker that shows the paragraph a case citation points to.

Nothing leaves your computer. Matters, files and decisions are stored in your browser's IndexedDB, and the PDF and
Word libraries are bundled in `vendor/`, so the tracker works offline.

## What it does

| Area | Features |
| --- | --- |
| **Dashboard** | Open matters, deadlines due in 7 days, overdue matters, fees outstanding, originals still awaiting redaction. Every matter sorted by deadline with days left, latest memo version and payment status. |
| **Matters** | Client, file number, court/tribunal, stage (Intake → Research → Drafting → Internal review → Sent to client → Revisions → Closed), deadline, fee, invoice number, notes, tasks checklist. |
| **Files** | Original documents, redacted documents, supporting files and correspondence. Each original shows *Needs redaction* until a redacted copy is linked to it (or you mark it *Not needed*). |
| **Memo versions** | Upload each draft as v1, v2, v3… with a note on what changed. Compare any two consecutive `.docx` versions paragraph by paragraph. |
| **Payments** | Record each payment; the matter shows Unpaid / Part paid / Paid and the balance owing. |
| **Citation checker** | Open a memo (or pick a saved version). Every citation is highlighted: green = pinpoint found, amber = no pinpoint or paragraph doesn't exist, red = case not in your library. **Hover a citation to see the cited paragraph(s).** |
| **Case library** | Add decisions as PDF, `.docx`, `.txt` or pasted text. The neutral citation is detected and the decision is split into numbered paragraphs (`[12]` or `12.` style). |
| **Backup** | Export everything (including files) to one `.json` file and restore it on another computer. |

### What the citation checker recognises

- Neutral citations: `2019 SCC 65`, `2021 ONSC 4567`, `2023 ONCA 12`, `2020 FC 1234`, `2018 HRTO 55`
- CanLII citations: `2015 CanLII 12345 (ON SC)`
- Pinpoints: `at para 23`, `at paras 10-12`, `at ¶ 5`
- `Ibid at para 3` → resolved to the last full citation

Not yet: short forms such as *Vavilov at para 99*, and statute sections. The report reminds you to check those by hand.

**Safety:** the checker never writes or guesses a paragraph. It only shows text from decisions you loaded. A case
that isn't in your library is flagged red, not filled in.

## Running it

Serve the folder with any static server and open it in Chrome, Edge or Firefox:

```sh
cd memo-tracker
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` directly from disk also works in most browsers, but a local server is more reliable.

Data lives in that browser profile for that address (`http://localhost:8080`). Use **Backup → Export** regularly;
clearing site data deletes it.

## Word add-in (citations inside Word)

`word-addin/` is a Word task-pane add-in that uses the same citation engine (`citations.js`).

Word does not let add-ins react to the mouse hovering over text, so the add-in works on the **cursor**: click into a
citation and the task pane shows the cited paragraph. **Scan document** lists every citation with its status; clicking
one selects it in the document. The add-in only reads the document; it never changes it.

Setup (one time):

1. In the tracker, go to **Case library → Export library for Word add-in** to save `case-library.json`.
2. Serve this folder over HTTPS on port 3000 (Office requires HTTPS):
   ```sh
   npx office-addin-dev-certs install
   npx http-server memo-tracker -p 3000 -S \
     -C ~/.office-addin-dev-certs/localhost.crt -K ~/.office-addin-dev-certs/localhost.key
   ```
3. Sideload `word-addin/manifest.xml`:
   - **Word on the web:** Insert → Add-ins → Upload My Add-in → choose `manifest.xml`.
   - **Word for Windows:** put the manifest in a shared network folder, add that folder under
     File → Options → Trust Center → Trusted Add-in Catalogs, then Insert → My Add-ins → Shared Folder.
   - **Word for Mac:** copy `manifest.xml` to `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`.
4. Home → **Check citations**, then **Load case-library.json**. Re-export and reload it after adding decisions.

## Files

```
memo-tracker/
  index.html, app.js, styles.css   the tracker
  citations.js                     citation detection, paragraph splitting, checking (shared with the add-in)
  vendor/                          mammoth.js 1.6.0 (Word → HTML/text), pdf.js 3.11.174 (PDF text), with licences
  word-addin/                      manifest.xml, taskpane.html, taskpane.js, icons
```

## Ideas for next steps

- Short-form citations (*Vavilov at para 99*) matched by style of cause
- Pull decisions automatically from CanLII / A2AJ by citation instead of adding them by hand
- Statute and regulation pinpoints (s. 96 IRPA) against a legislation library
- Calendar reminders (.ics export) for deadlines; invoice PDF generation
- Time tracking per matter against the fee
- Optional encrypted sync between computers
