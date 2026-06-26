from setuptools import setup

package_name = "webviz_ros2_adapter"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools", "websockets>=11"],
    zip_safe=True,
    maintainer="Xianchao Long",
    maintainer_email="longxianchao@gmail.com",
    description="Drop-in ROS 2 node that mirrors topics to a WebViz hub (§6.2).",
    license="MIT",
    entry_points={
        "console_scripts": [
            "adapter = webviz_ros2_adapter.adapter:main",
        ],
    },
)
