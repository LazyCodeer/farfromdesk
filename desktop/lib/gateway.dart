import 'updates.dart';

abstract class Gateway {
  Future<Map<String, dynamic>> get(String path);
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data);
  Future<String?> chooseFile(String label);
  Future<Map<String, dynamic>> readDocument(String path);
  Future<bool> startupEnabled();
  Future<void> setStartup(bool enabled);
  Future<void> reportReady() async {}
  Future<UpdateCheck> checkUpdates({bool manual = false}) async =>
      const UpdateCheck();
  Future<void> openReleasePage(Uri uri) async {}
  bool get canInstallUpdate => false;
  Future<void> installUpdate(AppRelease release, void Function(Map<String, dynamic>) progress) async {
    throw UnsupportedError('Automatic installation is not available on this platform.');
  }
  void closeUpdates() {}
  String get platform;
  bool get preview => false;
  int get initialScreen => 0;
}
