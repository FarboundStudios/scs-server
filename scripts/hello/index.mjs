export function onCommand({ player, args }) {
  if (args[0] === 'position') {
    if (!player.position) return 'Enter driving mode to see your position.';
    const { x, z } = player.position;
    return 'ETS2 position: ' + Math.round(x) + ', ' + Math.round(z);
  }
  return 'Hello, ' + player.name + '! Use /script hello position to see your position.';
}
