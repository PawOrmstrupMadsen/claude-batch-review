import { main } from "./action.js";

main().then((code) => {
  process.exitCode = code;
});
