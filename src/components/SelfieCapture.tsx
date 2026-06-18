import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

// The camera screen is always dark, regardless of clocked-in state.
import { darkColors as colors } from "../theme";

type Props = {
  visible: boolean;
  onCancel: () => void;
  onUse: (dataUrl: string) => void;
};

/**
 * Front-camera selfie capture for clock-in. Shown only when the org requires a
 * selfie on punch. Take → preview → Retake / Use. "Use" hands a JPEG data URL
 * back to the caller, which sends it with the clock-in punch (the server caps
 * it at ~512 KB, so we shoot at low quality).
 */
export function SelfieCapture({ visible, onCancel, onUse }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function take() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.3,
      });
      if (photo?.base64) {
        setPreview(`data:image/jpeg;base64,${photo.base64}`);
      }
    } catch {
      // Capture failed — the user can just tap again.
    } finally {
      setCapturing(false);
    }
  }

  function cancel() {
    setPreview(null);
    onCancel();
  }

  function use() {
    if (!preview) return;
    const dataUrl = preview;
    setPreview(null);
    onUse(dataUrl);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={cancel}>
      <View style={styles.container}>
        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.message}>
              Clox needs camera access to take a clock-in selfie.
            </Text>
            <TouchableOpacity style={styles.primary} onPress={requestPermission}>
              <Text style={styles.primaryText}>Allow camera</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={cancel} hitSlop={12}>
              <Text style={styles.link}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : preview ? (
          <>
            <Image source={{ uri: preview }} style={styles.fill} />
            <View style={styles.controls}>
              <TouchableOpacity
                style={styles.secondary}
                onPress={() => setPreview(null)}
              >
                <Text style={styles.secondaryText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primary} onPress={use}>
                <Text style={styles.primaryText}>Use photo</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <CameraView ref={cameraRef} style={styles.fill} facing="front" />
            <View style={styles.controls}>
              <TouchableOpacity onPress={cancel} hitSlop={12}>
                <Text style={styles.link}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.shutter}
                onPress={take}
                disabled={capturing}
                activeOpacity={0.8}
              >
                {capturing ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <View style={styles.shutterInner} />
                )}
              </TouchableOpacity>
              <View style={styles.spacer} />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    backgroundColor: colors.bg,
  },
  fill: { flex: 1 },
  message: {
    color: colors.text,
    fontSize: 17,
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 24,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 28,
    paddingVertical: 28,
    backgroundColor: "#000",
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.text,
  },
  spacer: { width: 60 },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 28,
    alignItems: "center",
    marginBottom: 16,
  },
  primaryText: { color: colors.accentText, fontSize: 17, fontWeight: "700" },
  secondary: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 28,
    alignItems: "center",
  },
  secondaryText: { color: colors.text, fontSize: 17, fontWeight: "700" },
  link: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
});
