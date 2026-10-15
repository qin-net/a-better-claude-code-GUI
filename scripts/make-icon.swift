#!/usr/bin/env swift
//
// Renders the app icon to a 1024×1024 PNG.
//
// macOS icons are not full-bleed squares: the artwork sits in a rounded rect of
// 824×824 centred in a 1024 canvas (corner radius 185.4), which is what keeps it
// visually consistent with the system and third-party icons in the Dock.
//
// The mark is a shell prompt — a ">" chevron with a command bar beside it —
// drawn in the app's accent colour on its own dark background.

import Foundation
import CoreGraphics
import ImageIO
import AppKit

let canvas = 1024.0
let box = 824.0
let boxOrigin = (canvas - box) / 2.0
let cornerRadius = 185.4

let outPath = CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : "scripts/icon.png"

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: Double = 1.0) -> CGColor {
  CGColor(red: CGFloat(r) / 255.0, green: CGFloat(g) / 255.0,
          blue: CGFloat(b) / 255.0, alpha: CGFloat(a))
}

let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
  data: nil, width: Int(canvas), height: Int(canvas),
  bitsPerComponent: 8, bytesPerRow: 0, space: space,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  FileHandle.standardError.write("could not create bitmap context\n".data(using: .utf8)!)
  exit(1)
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = .high

// ------------------------------------------------------------------ background

let plate = CGRect(x: boxOrigin, y: boxOrigin, width: box, height: box)
let platePath = CGPath(roundedRect: plate, cornerWidth: cornerRadius,
                       cornerHeight: cornerRadius, transform: nil)

ctx.saveGState()
ctx.addPath(platePath)
ctx.clip()
// A gentle top-to-bottom gradient keeps the plate from reading as a flat hole
// against the dark menu bar in dark mode.
let gradient = CGGradient(
  colorsSpace: space,
  colors: [rgb(0x2c, 0x2c, 0x33), rgb(0x12, 0x12, 0x16)] as CFArray,
  locations: [0.0, 1.0]
)!
ctx.drawLinearGradient(
  gradient,
  start: CGPoint(x: plate.midX, y: plate.maxY),
  end: CGPoint(x: plate.midX, y: plate.minY),
  options: []
)
ctx.restoreGState()

// ----------------------------------------------------------------------- mark

// Work in canvas coordinates; the glyph is centred in the plate.
let cy = boxOrigin + box / 2.0
let accent = rgb(0xd9, 0x77, 0x57)
let strokeWidth = 62.0

// ">" chevron
let chevron = CGMutablePath()
chevron.move(to: CGPoint(x: boxOrigin + 214, y: cy + 94))
chevron.addLine(to: CGPoint(x: boxOrigin + 370, y: cy))
chevron.addLine(to: CGPoint(x: boxOrigin + 214, y: cy - 94))

ctx.setStrokeColor(accent)
ctx.setLineWidth(strokeWidth)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.addPath(chevron)
ctx.strokePath()

// command bar
let bar = CGRect(x: boxOrigin + 434, y: cy - 31, width: 212, height: 62)
ctx.setFillColor(accent)
ctx.addPath(CGPath(roundedRect: bar, cornerWidth: 31, cornerHeight: 31, transform: nil))
ctx.fillPath()

// ---------------------------------------------------------------------- write

guard let image = ctx.makeImage() else {
  FileHandle.standardError.write("could not snapshot context\n".data(using: .utf8)!)
  exit(1)
}
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
  FileHandle.standardError.write("could not open \(outPath) for writing\n".data(using: .utf8)!)
  exit(1)
}
CGImageDestinationAddImage(dest, image, nil)
if !CGImageDestinationFinalize(dest) {
  FileHandle.standardError.write("could not write \(outPath)\n".data(using: .utf8)!)
  exit(1)
}
print("wrote \(outPath)")
