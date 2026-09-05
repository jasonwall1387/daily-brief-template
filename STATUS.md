# Status - 2026-09-05

- Fixed the P1 cloud-to-filesystem boundary: calendar-date validation, relative brief
  directories, rejection of linked paths below the vault root, and atomic note replacement.
- The collector acknowledges a D1 brief only after the local write succeeds.
- Added eight regression tests using synthetic files and mocked D1 responses. `node --test` passes locally.
- Remaining audit findings, including duplicate-date handling and scheduler setup issues,
  are outside this change.
