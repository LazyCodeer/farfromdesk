#ifndef RUNNER_SOCIAL_SHARE_H_
#define RUNNER_SOCIAL_SHARE_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <memory>
#include <string>
#include <vector>

// The "farfromdesk/social-share" channel on Windows: opens the system Share
// window (DataTransferManager) for a post's caption and JPEG slides, the
// counterpart of NSSharingServicePicker on a Mac. It reports that the window
// was opened, never that anything was shared or posted.
class SocialShare {
 public:
  // Posted to the window once the slide files are ready to hand to Windows.
  static constexpr UINT kReadyMessage = WM_APP + 0x51;

  SocialShare(flutter::BinaryMessenger* messenger, HWND window);
  ~SocialShare();
  SocialShare(const SocialShare&) = delete;
  SocialShare& operator=(const SocialShare&) = delete;

  // Handles kReadyMessage from the window procedure. Returns true when handled.
  bool HandleMessage(UINT message, WPARAM wparam, LPARAM lparam);

 private:
  struct Impl;
  void Show(const flutter::EncodableValue* arguments,
            std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  HWND window_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  std::unique_ptr<Impl> impl_;
};

#endif  // RUNNER_SOCIAL_SHARE_H_
