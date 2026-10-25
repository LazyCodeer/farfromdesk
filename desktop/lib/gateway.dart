abstract class Gateway {
  Future<Map<String, dynamic>> get(String path);
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data);
  Future<String?> chooseFile(String label);
  Future<Map<String, dynamic>> readDocument(String path);
  Future<bool> startupEnabled();
  Future<void> setStartup(bool enabled);
  String get platform;
  bool get preview => false;
  int get initialScreen => 0;
}
