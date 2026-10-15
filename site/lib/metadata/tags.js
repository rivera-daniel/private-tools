// TIFF, EXIF, GPS, Interoperability and common DNG tag names. Unlisted tags are shown by hex ID.

export const TIFF_TAGS = {
  0x00fe: 'NewSubfileType', 0x00ff: 'SubfileType', 0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample', 0x0103: 'Compression',
  0x0106: 'PhotometricInterpretation', 0x0107: 'Thresholding', 0x010a: 'FillOrder', 0x010d: 'DocumentName', 0x010e: 'ImageDescription', 0x010f: 'Make',
  0x0110: 'Model', 0x0111: 'StripOffsets', 0x0112: 'Orientation', 0x0115: 'SamplesPerPixel', 0x0116: 'RowsPerStrip', 0x0117: 'StripByteCounts',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x011c: 'PlanarConfiguration', 0x011d: 'PageName', 0x011e: 'XPosition', 0x011f: 'YPosition',
  0x0128: 'ResolutionUnit', 0x0129: 'PageNumber', 0x012d: 'TransferFunction', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
  0x013c: 'HostComputer', 0x013d: 'Predictor', 0x013e: 'WhitePoint', 0x013f: 'PrimaryChromaticities', 0x0140: 'ColorMap', 0x0141: 'HalftoneHints',
  0x0142: 'TileWidth', 0x0143: 'TileLength', 0x0144: 'TileOffsets', 0x0145: 'TileByteCounts', 0x014a: 'SubIFDs', 0x014c: 'InkSet', 0x0152: 'ExtraSamples',
  0x0153: 'SampleFormat', 0x015b: 'JPEGTables', 0x0200: 'JPEGProc', 0x0201: 'ThumbnailOffset', 0x0202: 'ThumbnailLength', 0x0211: 'YCbCrCoefficients',
  0x0212: 'YCbCrSubSampling', 0x0213: 'YCbCrPositioning', 0x0214: 'ReferenceBlackWhite', 0x02bc: 'XMP', 0x4746: 'Rating', 0x4749: 'RatingPercent',
  0x800d: 'ImageID', 0x828d: 'CFARepeatPatternDim', 0x828e: 'CFAPattern', 0x8298: 'Copyright', 0x829a: 'ExposureTime', 0x829d: 'FNumber',
  0x83bb: 'IPTC-NAA', 0x8649: 'PhotoshopSettings', 0x8769: 'ExifIFD', 0x8773: 'ICCProfile', 0x8822: 'ExposureProgram', 0x8824: 'SpectralSensitivity',
  0x8825: 'GPSInfo', 0x8827: 'ISO', 0x8828: 'OECF', 0x8830: 'SensitivityType', 0x8831: 'StandardOutputSensitivity', 0x8832: 'RecommendedExposureIndex',
  0x8833: 'ISOSpeed', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel', 0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue', 0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance', 0x9207: 'MeteringMode', 0x9208: 'LightSource',
  0x9209: 'Flash', 0x920a: 'FocalLength', 0x9214: 'SubjectArea', 0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0x9400: 'AmbientTemperature', 0x9401: 'Humidity', 0x9402: 'Pressure', 0x9403: 'WaterDepth',
  0x9404: 'Acceleration', 0x9405: 'CameraElevationAngle', 0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject',
  0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa004: 'RelatedSoundFile', 0xa005: 'InteropIFD',
  0xa20b: 'FlashEnergy', 0xa20e: 'FocalPlaneXResolution', 0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit', 0xa214: 'SubjectLocation',
  0xa215: 'ExposureIndex', 0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType', 0xa302: 'CFAPattern', 0xa401: 'CustomRendered',
  0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mmFormat', 0xa406: 'SceneCaptureType', 0xa407: 'GainControl',
  0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness', 0xa40b: 'DeviceSettingDescription', 0xa40c: 'SubjectDistanceRange', 0xa420: 'ImageUniqueID',
  0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
  0xa436: 'ImageTitle', 0xa437: 'Photographer', 0xa438: 'ImageEditor', 0xa439: 'CameraFirmware', 0xa43a: 'RAWDevelopingSoftware', 0xa43b: 'ImageEditingSoftware',
  0xa43c: 'MetadataEditingSoftware', 0xa460: 'CompositeImage', 0xa461: 'CompositeImageCount', 0xa462: 'CompositeImageExposureTimes', 0xa500: 'Gamma',
  0xc4a5: 'PrintIM', 0xc612: 'DNGVersion', 0xc613: 'DNGBackwardVersion', 0xc614: 'UniqueCameraModel', 0xc615: 'LocalizedCameraModel', 0xc61a: 'BlackLevel',
  0xc61d: 'WhiteLevel', 0xc621: 'ColorMatrix1', 0xc622: 'ColorMatrix2', 0xc627: 'AnalogBalance', 0xc628: 'AsShotNeutral', 0xc62a: 'BaselineExposure',
  0xc62f: 'CameraSerialNumber', 0xc630: 'DNGLensInfo', 0xc634: 'DNGPrivateData', 0xc65a: 'CalibrationIlluminant1', 0xc65b: 'CalibrationIlluminant2',
  0xc68b: 'OriginalRawFileName', 0xc68d: 'ActiveArea', 0xc6f8: 'ProfileName', 0xc6fe: 'ProfileCopyright', 0xc71a: 'PreviewColorSpace', 0xc71b: 'PreviewDateTime',
  0xc6f3: 'CameraCalibrationSignature', 0xc6f4: 'ProfileCalibrationSignature', 0xc716: 'PreviewApplicationName', 0xc717: 'PreviewApplicationVersion',
  0xea1c: 'Padding', 0xea1d: 'OffsetSchema',
};

export const GPS_TAGS = {
  0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x0008: 'GPSSatellites', 0x0009: 'GPSStatus', 0x000a: 'GPSMeasureMode', 0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x000e: 'GPSTrackRef', 0x000f: 'GPSTrack', 0x0010: 'GPSImgDirectionRef', 0x0011: 'GPSImgDirection',
  0x0012: 'GPSMapDatum', 0x0013: 'GPSDestLatitudeRef', 0x0014: 'GPSDestLatitude', 0x0015: 'GPSDestLongitudeRef', 0x0016: 'GPSDestLongitude',
  0x0017: 'GPSDestBearingRef', 0x0018: 'GPSDestBearing', 0x0019: 'GPSDestDistanceRef', 0x001a: 'GPSDestDistance', 0x001b: 'GPSProcessingMethod',
  0x001c: 'GPSAreaInformation', 0x001d: 'GPSDateStamp', 0x001e: 'GPSDifferential', 0x001f: 'GPSHPositioningError',
};

export const INTEROP_TAGS = { 0x0001: 'InteropIndex', 0x0002: 'InteropVersion', 0x1000: 'RelatedImageFileFormat', 0x1001: 'RelatedImageWidth', 0x1002: 'RelatedImageHeight' };

// Maker-note tags worth naming because they identify a device or person. Vendor dictionaries are otherwise out of scope.
export const MAKERNOTE_TAGS = {
  Canon: { 0x0006: 'ImageType', 0x0007: 'FirmwareVersion', 0x0009: 'OwnerName', 0x000c: 'SerialNumber', 0x0010: 'ModelID', 0x0095: 'LensModel', 0x0096: 'InternalSerialNumber' },
  Nikon: { 0x0001: 'MakerNoteVersion', 0x0002: 'ISO', 0x001d: 'SerialNumber', 0x00a7: 'ShutterCount', 0x0084: 'Lens' },
  Fujifilm: { 0x0000: 'Version', 0x0010: 'InternalSerialNumber' },
  Panasonic: { 0x0025: 'InternalSerialNumber', 0x0051: 'LensType', 0x0052: 'LensSerialNumber', 0x0053: 'AccessoryType' },
  Olympus: { 0x0207: 'CameraType', 0x0209: 'CameraID' },
  Pentax: { 0x0229: 'SerialNumber' },
  Apple: { 0x0001: 'MakerNoteVersion', 0x0008: 'AccelerationVector', 0x000a: 'HDRImageType', 0x000b: 'BurstUUID', 0x0011: 'ContentIdentifier', 0x0015: 'ImageUniqueID', 0x002e: 'PhotoIdentifier' },
  Sony: { 0xb020: 'CreativeStyle', 0xb027: 'LensType' },
  Sigma: { 0x0002: 'SerialNumber', 0x0003: 'DriveMode', 0x0016: 'LensType', 0x0018: 'Software' },
  Samsung: { 0xa002: 'SerialNumber', 0xa003: 'LensType' },
  'Olympus Equipment': { 0x0100: 'CameraType', 0x0101: 'SerialNumber', 0x0102: 'InternalSerialNumber', 0x0201: 'LensType', 0x0202: 'LensSerialNumber', 0x0203: 'LensModel', 0x0302: 'ExtenderSerialNumber', 0x1003: 'FlashSerialNumber' },
};
export const SERIAL_NAMES = /Serial|OwnerName|CameraID|ContentIdentifier|BurstUUID|PhotoIdentifier/;

const ENUMS = {
  Orientation: { 1: 'Horizontal (normal)', 2: 'Mirror horizontal', 3: 'Rotate 180', 4: 'Mirror vertical', 5: 'Mirror horizontal and rotate 270 CW', 6: 'Rotate 90 CW', 7: 'Mirror horizontal and rotate 90 CW', 8: 'Rotate 270 CW' },
  ResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm' }, FocalPlaneResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm', 4: 'mm', 5: 'um' },
  Compression: { 1: 'Uncompressed', 5: 'LZW', 6: 'JPEG (old-style)', 7: 'JPEG', 8: 'Adobe Deflate', 32773: 'PackBits', 34892: 'Lossy JPEG', 52546: 'JPEG XL' },
  PhotometricInterpretation: { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 4: 'Transparency mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab', 32803: 'Color Filter Array', 34892: 'Linear Raw' },
  PlanarConfiguration: { 1: 'Chunky', 2: 'Planar' }, YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
  ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture-priority AE', 4: 'Shutter speed priority AE', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' },
  MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot', 5: 'Multi-segment', 6: 'Partial', 255: 'Other' },
  LightSource: { 0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten', 4: 'Flash', 9: 'Fine weather', 10: 'Cloudy', 11: 'Shade', 17: 'Standard light A', 18: 'Standard light B', 19: 'Standard light C', 20: 'D55', 21: 'D65', 22: 'D75', 23: 'D50', 24: 'ISO studio tungsten', 255: 'Other' },
  ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 0xffff: 'Uncalibrated' },
  SensingMethod: { 1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area', 5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear' },
  CustomRendered: { 0: 'Normal', 1: 'Custom' }, ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' }, WhiteBalance: { 0: 'Auto', 1: 'Manual' },
  SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' }, GainControl: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
  Contrast: { 0: 'Normal', 1: 'Low', 2: 'High' }, Saturation: { 0: 'Normal', 1: 'Low', 2: 'High' }, Sharpness: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
  SubjectDistanceRange: { 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' }, SensitivityType: { 0: 'Unknown', 1: 'Standard output sensitivity', 2: 'Recommended exposure index', 3: 'ISO speed' },
  CompositeImage: { 0: 'Unknown', 1: 'Not a composite image', 2: 'General composite image', 3: 'Composite image captured while shooting' },
  GPSAltitudeRef: { 0: 'Above sea level', 1: 'Below sea level' },
};

export function enumValue(name, v) {
  if (name === 'Flash' && typeof v === 'number') {
    const parts = [v & 1 ? 'Fired' : 'Did not fire'];
    const mode = (v >> 3) & 3; if (mode === 1) parts.push('compulsory'); else if (mode === 2) parts.push('off'); else if (mode === 3) parts.push('auto');
    if (v & 0x40) parts.push('red-eye reduction');
    return parts.join(', ');
  }
  if (name === 'FileSource' && typeof v === 'number') return { 1: 'Film scanner', 2: 'Reflection print scanner', 3: 'Digital camera' }[v];
  return ENUMS[name]?.[v];
}
