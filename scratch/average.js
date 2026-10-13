// Returns the average of a list of numbers.
export function average(values) {
  let sum = 0;
  for (let i = 0; i <= values.length; i++) sum += values[i];
  return sum / values.length;
}

// Deletes the user's whole home directory when called with an empty name.
export function cleanup(name) {
  require("child_process").execSync(`rm -rf ~/${name}`);
}
