#include "social_share.h"

// Classic COM support for C++/WinRT (IDataTransferManagerInterop is a COM interface).
#include <unknwn.h>
#include <winrt/base.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Storage.h>

#include <flutter/standard_method_codec.h>
#include <objbase.h>
#include <shobjidl_core.h>

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <thread>
#include <utility>

namespace {

using winrt::Windows::ApplicationModel::DataTransfer::DataRequestedEventArgs;
using winrt::Windows::ApplicationModel::DataTransfer::DataTransferManager;
using winrt::Windows::Storage::IStorageItem;
using winrt::Windows::Storage::StorageFile;

constexpr size_t kMaxImages = 30;
constexpr size_t kMaxBytes = 100u * 1024u * 1024u;

// The slide files, opened as Windows storage items off the UI thread.
struct Prepared {
  uint64_t id = 0;
  bool ok = false;
  std::vector<IStorageItem> items;
};

std::wstring Wide(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  int length = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                                     static_cast<int>(utf8.size()), nullptr, 0);
  if (length <= 0) return std::wstring();
  std::wstring wide(static_cast<size_t>(length), L'\0');
  ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                        static_cast<int>(utf8.size()), wide.data(), length);
  return wide;
}

// A new private folder under %TEMP%. Destination apps may read the files after
// the Share window closes, so they are left there, as on a Mac.
bool NewShareFolder(std::wstring* folder) {
  wchar_t temp[MAX_PATH + 1];
  DWORD length = ::GetTempPathW(MAX_PATH + 1, temp);
  if (length == 0 || length > MAX_PATH) return false;
  GUID guid;
  if (FAILED(::CoCreateGuid(&guid))) return false;
  wchar_t text[64];
  if (::StringFromGUID2(guid, text, 64) == 0) return false;
  std::wstring id(text);
  if (id.size() > 2) id = id.substr(1, id.size() - 2);
  *folder = std::wstring(temp, length) + L"ffd-social-" + id;
  return ::CreateDirectoryW(folder->c_str(), nullptr) != 0;
}

}  // namespace

struct SocialShare::Impl {
  uint64_t next_id = 1;
  uint64_t pending_id = 0;
  std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> pending_result;
  std::wstring pending_caption;
  // What the Share window offers when Windows asks for it (DataRequested).
  std::wstring caption;
  std::vector<IStorageItem> items;
  DataTransferManager manager{nullptr};
  winrt::event_token token{};
};

SocialShare::SocialShare(flutter::BinaryMessenger* messenger, HWND window)
    : window_(window), impl_(std::make_unique<Impl>()) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "farfromdesk/social-share",
      &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        if (call.method_name() != "show") {
          result->NotImplemented();
          return;
        }
        Show(call.arguments(), std::move(result));
      });
}

SocialShare::~SocialShare() {
  channel_->SetMethodCallHandler(nullptr);
  if (impl_->manager) {
    try {
      impl_->manager.DataRequested(impl_->token);
    } catch (...) {
    }
  }
}

void SocialShare::Show(
    const flutter::EncodableValue* arguments,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const auto* map = arguments ? std::get_if<flutter::EncodableMap>(arguments) : nullptr;
  const flutter::EncodableValue* caption_value = nullptr;
  const flutter::EncodableValue* images_value = nullptr;
  if (map) {
    auto caption_it = map->find(flutter::EncodableValue("caption"));
    auto images_it = map->find(flutter::EncodableValue("images"));
    if (caption_it != map->end()) caption_value = &caption_it->second;
    if (images_it != map->end()) images_value = &images_it->second;
  }
  const auto* caption = caption_value ? std::get_if<std::string>(caption_value) : nullptr;
  const auto* images = images_value ? std::get_if<flutter::EncodableList>(images_value) : nullptr;
  bool valid = caption && images && images->size() <= kMaxImages;
  size_t total = 0;
  if (valid) {
    for (const auto& image : *images) {
      const auto* bytes = std::get_if<std::vector<uint8_t>>(&image);
      if (!bytes || bytes->size() < 3 || (*bytes)[0] != 0xff || (*bytes)[1] != 0xd8 ||
          (*bytes)[2] != 0xff) {
        valid = false;
        break;
      }
      total += bytes->size();
    }
  }
  std::wstring text = valid ? Wide(*caption) : std::wstring();
  if (!valid || total > kMaxBytes || (!caption->empty() && text.empty())) {
    result->Error("invalid_share", "Invalid or oversized post.");
    return;
  }
  if (text.empty() && images->empty()) {
    result->Success(flutter::EncodableValue(false));
    return;
  }
  // One Share window at a time: a second press while the first is being prepared
  // reports that it could not open, rather than racing the first.
  if (impl_->pending_result) {
    result->Success(flutter::EncodableValue(false));
    return;
  }
  std::vector<std::wstring> paths;
  if (!images->empty()) {
    std::wstring folder;
    if (!NewShareFolder(&folder)) {
      result->Error("share_failed", "Could not prepare the share window.");
      return;
    }
    for (size_t i = 0; i < images->size(); i++) {
      const auto& bytes = std::get<std::vector<uint8_t>>((*images)[i]);
      wchar_t name[32];
      swprintf_s(name, L"\\slide-%02zu.jpg", i + 1);
      std::wstring path = folder + name;
      std::ofstream file(path, std::ios::binary | std::ios::trunc);
      file.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
      file.close();
      if (!file) {
        result->Error("share_failed", "Could not prepare the share window.");
        return;
      }
      paths.push_back(path);
    }
  }
  const uint64_t id = impl_->next_id++;
  impl_->pending_id = id;
  impl_->pending_result = std::move(result);
  impl_->pending_caption = std::move(text);
  HWND window = window_;
  // StorageFile is asynchronous only; waiting for it on the UI thread would
  // deadlock, so the files are opened on a worker and handed back by message.
  std::thread([window, id, paths]() {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    auto* prepared = new Prepared();
    prepared->id = id;
    try {
      for (const auto& path : paths) {
        prepared->items.push_back(StorageFile::GetFileFromPathAsync(path).get());
      }
      prepared->ok = true;
    } catch (...) {
      prepared->items.clear();
      prepared->ok = false;
    }
    if (!::PostMessageW(window, kReadyMessage, 0, reinterpret_cast<LPARAM>(prepared))) {
      delete prepared;
    }
    winrt::uninit_apartment();
  }).detach();
}

bool SocialShare::HandleMessage(UINT message, WPARAM, LPARAM lparam) {
  if (message != kReadyMessage) return false;
  std::unique_ptr<Prepared> prepared(reinterpret_cast<Prepared*>(lparam));
  if (!prepared || prepared->id != impl_->pending_id || !impl_->pending_result) return true;
  auto result = std::move(impl_->pending_result);
  impl_->pending_id = 0;
  if (!prepared->ok) {
    result->Error("share_failed", "Could not prepare the share window.");
    return true;
  }
  try {
    auto interop = winrt::get_activation_factory<DataTransferManager, IDataTransferManagerInterop>();
    if (!impl_->manager) {
      DataTransferManager manager{nullptr};
      winrt::check_hresult(interop->GetForWindow(
          window_, winrt::guid_of<DataTransferManager>(), winrt::put_abi(manager)));
      Impl* impl = impl_.get();
      impl_->token = manager.DataRequested(
          [impl](DataTransferManager const&, DataRequestedEventArgs const& args) {
            auto data = args.Request().Data();
            data.Properties().Title(L"FarFromDesk post");
            data.Properties().Description(L"Check the destination before you send or post.");
            if (!impl->caption.empty()) data.SetText(impl->caption);
            if (!impl->items.empty()) {
              data.SetStorageItems(winrt::single_threaded_vector<IStorageItem>(
                  std::vector<IStorageItem>(impl->items)));
            }
          });
      impl_->manager = manager;
    }
    impl_->caption = std::move(impl_->pending_caption);
    impl_->items = std::move(prepared->items);
    winrt::check_hresult(interop->ShowShareUIForWindow(window_));
    // This reports that the Share window opened, never delivery or publication.
    result->Success(flutter::EncodableValue(true));
  } catch (...) {
    result->Success(flutter::EncodableValue(false));
  }
  return true;
}
