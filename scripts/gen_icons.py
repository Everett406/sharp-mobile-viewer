#!/usr/bin/env python3
"""Generate Android app icons from source image."""
from PIL import Image
import os

src = Image.open('assets/app-icon.jpg').convert('RGBA')
src = src.resize((512, 512), Image.LANCZOS)

res_dir = 'android/app/src/main/res'

# Remove adaptive icon XML (overrides PNG icons on Android 8+)
for xml_name in ['ic_launcher.xml', 'ic_launcher_round.xml']:
    xml_path = f'{res_dir}/mipmap-anydpi-v26/{xml_name}'
    if os.path.exists(xml_path):
        os.remove(xml_path)
        print(f'Removed: {xml_path}')

# Generate PNG icons for all densities
sizes = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}
for folder, size in sizes.items():
    folder_path = f'{res_dir}/{folder}'
    os.makedirs(folder_path, exist_ok=True)
    for icon_name in ['ic_launcher.png', 'ic_launcher_round.png']:
        icon_path = f'{folder_path}/{icon_name}'
        src.resize((size, size), Image.LANCZOS).save(icon_path)
        print(f'Generated: {icon_path} ({size}x{size})')

# Replace foreground drawable for any remaining adaptive icon refs
for folder, size in {'drawable-mdpi': 108, 'drawable-hdpi': 162,
                     'drawable-xhdpi': 216, 'drawable-xxhdpi': 324,
                     'drawable-xxxhdpi': 432}.items():
    dpath = f'{res_dir}/{folder}'
    os.makedirs(dpath, exist_ok=True)
    src.resize((size, size), Image.LANCZOS).save(f'{dpath}/ic_launcher_foreground.png')
    print(f'Generated: {dpath}/ic_launcher_foreground.png ({size}x{size})')

print('Icon generation complete!')
