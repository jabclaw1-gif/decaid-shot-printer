# Shot Printer for Decaid

Prints each espresso shot on a receipt printer: the shot graph (pressure, flow and
weight) plus dose, yield, ratio, time, coffee, grinder and notes.

> **Status: experimental.** Tested only against mocks. It has not yet been run
> inside Decaid or on a physical printer.

It is designed for **network receipt printers that speak ESC/POS**, which many
58/80 mm thermal printers with an Ethernet or Wi-Fi port do. 80 mm printers set
to 512 dots instead of 576 will clip the right edge of the graph. The printer must be on the same
network as the tablet or computer running Decaid.

USB-only and Bluetooth-only printers are not supported. Decaid plugins can only
reach devices over the network.

## Install

Requires Decaid 0.9.0 or later.

1. In Decaid, open the **Plugins** page.
2. Open the **cogwheel** menu and choose **Install plugin**, then either:
   - **GitHub Branch**, with repo `jabclaw1-gif/decaid-shot-printer` and branch
     `main`, or
   - **ZIP file**, with the ZIP from this repo's **Code → Download ZIP**.
3. In the plugin's **⋯** menu, choose **Load** if it is not already loaded.
4. Choose **Settings** in the same menu and enter the **Printer IP address**.
   Saving reloads the plugin so the change applies at once.

On macOS, the first print makes macOS ask whether Decaid may find devices on
your local network. Choose **Allow**. If you missed it, turn Decaid on under
**System Settings → Privacy & Security → Local Network**.

Branch installs can update from GitHub. For a ZIP install, install the new ZIP
the same way; it replaces the installed version.

To find the printer IP, print its self-test page. On most models, hold the FEED
button while switching the printer on. The page lists its IP address.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Printer IP address | (empty) | Printer address, for example `192.168.1.50` |
| Printer port | 9100 | Raw printing port; almost always 9100 |
| Paper width | 80mm | `80mm` or `58mm` |
| Print every shot automatically | on | Print as soon as each shot is saved (shots not recorded within the last 10 minutes, such as backup imports, are skipped) |
| Minimum shot length | 10 s | Shorter shots (flushes, aborted shots) are not auto-printed |
| Header text | (empty) | Large line at the top, such as your cafe name |
| Footer text | (empty) | Line at the bottom |
| Show target curves | off | Adds the profile's pressure and flow targets as thin dotted lines |
| Cut paper | on | Turn off for printers without a cutter |

## Preview and manual printing

Open this page in any browser on your network. Replace `<decaid-ip>` with the
address of the tablet or computer running Decaid:

```
http://<decaid-ip>:8080/api/v1/plugins/shot-printer.reaplugin/preview
```

It shows a preview of the receipt, has a menu of recent shots, and a
**Print this shot** button. Other endpoints:

- `.../print` prints the latest shot; add `?shotId=<id>` for a specific one.
- `.../status` returns the printer settings and the result of the last print as JSON.

A skin can link to `.../print?shotId=<id>` to add a print button of its own.

## Security

The plugin's pages have no login. Anyone who can reach Decaid's port 8080 can
view shot details (including names and notes) and print receipts, and a web
page opened on the same network can trigger a print. Use it on a trusted
network, and do not expose port 8080 or the printer's port 9100 to the internet
or to guest Wi-Fi.

## Development

Run the tests with Node.js 22 or later: `node --test`

## How it works

1. Decaid sends the plugin a `shotStored` event when a shot is saved.
2. The plugin waits 3 seconds, then reads the full shot from
   `/api/v1/shots/<id>`.
   Decaid also sends `shotStored` for every shot imported from a backup, so
   auto-print skips any shot without a valid timestamp within 10 minutes of
   now. Imported shots can still be printed from the preview page.
3. It keeps only the espresso part of the recording, draws the graph into a
   black-and-white bitmap at the printer's resolution (576 dots wide for 80 mm,
   384 for 58 mm), and lays out the text.
4. It encodes everything as ESC/POS: normal printer text for the details and a
   `GS v 0` raster image for the graph, sent in 128-row bands.
5. It opens a raw TCP connection to the printer through `host.transport` and
   sends the job.

Text is converted to plain ASCII before printing (accents are removed), because
most receipt printers cannot print other characters with their default settings.

## Troubleshooting

- **Nothing prints.** Open the `status` endpoint and read `lastResult.error`.
  "Could not reach the printer" means the IP or port is wrong, or the printer is
  on a different network. On macOS, also check the Local Network permission (see
  Install).
- **A shot did not auto-print, and `status` shows `"reason": "old"`.** The shot
  has no valid timestamp within 10 minutes of now, usually because it came
  from an import. Print it from the preview page. If the computer's clock is
  wrong, fix the clock.
- **Graph prints as garbage characters.** The printer does not support the
  `GS v 0` raster command. This is rare; check the printer is in ESC/POS mode
  rather than a label or line-printer mode.
- **Paper is not cut.** The printer has no cutter, or the cutter is disabled in
  its own settings. Turn off **Cut paper**.
- Plugin log lines start with `[shot-printer]` in the Decaid logs.

## License

[MIT](LICENSE)
