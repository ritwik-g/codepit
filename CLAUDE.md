# CodePit

## Node version
- Use Node 22 for every npm command here: builds, tests, typecheck and `npm run dist:mac`. `package.json` requires `>=20.12`.
- The shell's default `node` is `/usr/local/bin/node`, which is v18.12.1. It is too old: `npm run dist:mac` fails under it with `ERR_REQUIRE_ESM` from electron-builder.
- Put nvm's Node 22 first on PATH in the same command, e.g.
  `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && node -v && npm run dist:mac`
  (shell state does not carry over between commands, so repeat the export each time).
