import type { PropsWithChildren } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Button, Host } from '@expo/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
export function Action({
  title,
  onPress,
  disabled,
  secondary = false,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Host matchContents>
      <Button
        label={title}
        onPress={onPress}
        disabled={disabled}
        variant={secondary ? 'outlined' : 'filled'}
        style={{ paddingVertical: 14 }}
      />
    </Host>
  );
}
export function Screen({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        flexGrow: 1,
        padding: 24,
        paddingBottom: insets.bottom + 24,
        gap: 18,
        maxWidth: 640,
        width: '100%',
        alignSelf: 'center',
      }}
    >
      {children}
    </ScrollView>
  );
}
export function Message({ children }: PropsWithChildren) {
  return (
    <Text selectable style={{ fontSize: 16, lineHeight: 24 }}>
      {children}
    </Text>
  );
}
export function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <Text
      selectable
      accessibilityRole="alert"
      style={{ color: '#a82424', fontSize: 16, lineHeight: 24 }}
    >
      {message}
    </Text>
  ) : null;
}
export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <ActivityIndicator />
      <Message>{label}</Message>
    </View>
  );
}
export const sessionStatus = {
  ACTIVE: 'En curso',
  COMPLETED: 'Finalizada',
  CANCELLED: 'Cancelada',
};
