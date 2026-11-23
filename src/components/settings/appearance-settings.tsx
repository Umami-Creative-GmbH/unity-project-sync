import type { ComponentType } from "react";
import { IconDeviceDesktop, IconMoon, IconSun, type IconProps } from "@tabler/icons-react";

import { SettingRow, SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isThemePreference } from "@/lib/settings";
import type { AppSettings, ThemePreference } from "@/lib/types";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ComponentType<IconProps> }[] = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
];

export function AppearanceSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <SettingsPage>
      <SettingsGroup title="Theme">
        <SettingRow
          label="Theme"
          description="System follows the Windows light/dark setting, also when it changes."
          control={({ labelId, descriptionId }) => (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={settings.theme}
              // Clicking the active item would clear a single toggle group: keep the choice.
              onValueChange={(v) => isThemePreference(v) && onChange({ theme: v })}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            >
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className="gap-1.5 px-3 data-[state=on]:bg-muted data-[state=on]:text-foreground"
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
