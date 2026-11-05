# Canvas Veil

Per-session noise for 2D canvas reads so trackers can't fingerprint you. Captcha/checkout excluded. Network only on key activation.

Free and open source. If it saves you time, you can support the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike), [PayPal](https://paypal.me/najzzz) or [Buy Me a Coffee](https://buymeacoffee.com/michaellip).

## Install

- From the Chrome Web Store: [Canvas Veil](https://chromewebstore.google.com/detail/facihabijmaihmhlgglablmbbgpjmfgn). Version 0.1.2.
- From this source: run `npm install` and then `npm run build`. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and select the `dist` folder.

## Permissions

`storage`.

## Pro features

The Chrome Web Store version asks for a Zovo membership key for some features. The key check runs in your browser, and its code is in this repository. The MIT license lets you use and change all of this code. If the extension helps you, please support the work with one of the links below.

## About this code

This repository holds the original source files of Canvas Veil. The source is version 0.2.0. The Chrome Web Store has version 0.1.2. The manifest is in `src`.

Build steps

```
npm install
npm run build
```

The build script is `tsc --noEmit && vitest run --passWithNoTests && node build.mjs`. It writes the extension to the `dist` folder. Node.js 20 or newer is recommended.

## Support this work

Every Zovo extension is free to install. If one saves you time, you can help me make more of them.

- [GitHub Sponsors](https://github.com/sponsors/theluckystrike)
- [PayPal](https://paypal.me/najzzz)
- [Buy Me a Coffee](https://buymeacoffee.com/michaellip)

A star on this repository also helps other people find it.

## More from the author

- [BeLikeNative](https://www.belikenative.com/). Check your English in a Chrome side panel.
- [NoteMods](https://notemods.com/). Open source Obsidian plugins for Bases, tables and tasks.
- [ml0x](https://ml0x.com/). Guardrails, tests and budget caps for Claude Code agents.
- [KickLLM](https://kickllm.com/). Compare LLM API prices across 25+ models.

All Zovo extensions are at https://zovo.one/open-source. All projects by Michael Lip are at https://barframe.com/projects/.

## License

MIT. See [LICENSE](LICENSE). Third-party files keep their own licenses and notices. The license does not cover the Zovo name or logo. If you publish a fork, please give it a different name and icon.
