/// Installation, native authentication and model access are separate checks.
String platformConnectionStatus(Map platform) {
  if (platform['available'] != true) return 'Not detected';
  final state = platform['connection']?['state'];
  if (platform['executionMode'] == 'desktop') return 'App · Available';
  if (state == 'configured') return 'API / token configured';
  if (state == 'signed-out') return 'Sign in or configure API';
  if (state == 'unknown') return 'Check unavailable';
  if (platform['canCreate'] == false) return 'Check configuration';
  return 'Terminal · Available';
}
