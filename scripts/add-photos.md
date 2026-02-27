# Photo Management Guide

## Directory Structure

```
src/assets/images/
├── hero/           # Full-width hero images (1920x1080 recommended)
├── gallery/        # General gallery photos
├── team/           # Team photos
└── robots/         # Robot detail shots
```

## Adding Photos

1. **Select your best photos** - Choose high-quality, well-lit shots that tell the engineering story
2. **Copy to appropriate folder** in `src/assets/images/`
3. **Rename clearly** - Use descriptive names like `frc-2024-robot-action.jpg`

## Recommended Photos

### Hero Images (5-10)
- Robot in competition action
- Team celebrating a win
- Students working together on robot
- Close-up of robot mechanism
- Team at competition venue

### Gallery (20-30 curated)
- Build season highlights
- Competition moments
- Mentor-student collaboration
- Technical work (CAD, coding, machining)
- Outreach events

### Team Photos
- Full team photo
- Subteam photos (mechanical, programming, business)
- Mentor group

## Image Optimization

Astro automatically handles:
- WebP conversion for smaller files
- Responsive sizing for mobile/desktop
- Lazy loading for performance
- Quality optimization

Just drop your photos in - the build process handles the rest!

## Quick Add Script

From the photos folder, copy specific images:

```bash
# Copy a few hero images
cp "photos/robot - 100.jpeg" src/assets/images/hero/competition-action.jpg
cp "photos/robot - 200.jpeg" src/assets/images/hero/robot-closeup.jpg
```

## Pro Tips

1. **Quality over quantity** - 30 great photos beats 500 mediocre ones
2. **Tell a story** - Show the journey from design to competition
3. **Show diversity** - Different activities, roles, and moments
4. **Action shots** - Movement and energy convey excitement
5. **Detail shots** - Close-ups show engineering craftsmanship
